// 새 문서 만들기 어댑터 — SPEC-003 기술 검증(#35)에서 확인한 절차를 함수로 둔다(ADR 003). 스타일은 styles.ts(#37).
// rhwp 기본 동작이 스펙과 다른 곳만 바로잡는다(ADR 002 원칙 그대로):
// - createTable 은 표 문단·칸 문단·표 아래 빈 문단에 넣는 자리 문단 모양·글자 모양을 물려준다
//   (개요 문단 뒤면 모두 개요 번호를, 굵은 문단 뒤면 칸 글자가 굵게) → 새 문단을 바탕글 모양으로 맞춘 뒤 표를 넣고,
//   rhwp 가 덧붙인 표 아래 빈 문단은 지운다
// - 양식 본문 비우기: 구역 첫 문단(구역·단 정의)과 머리말·꼬리말·쪽 번호 위치가 든 문단은 남기고 글자·다른 개체를 지운다
import { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import { blockPositionSchema, type Block } from './block-schema.ts';
import { bodyControlsAt, type BodyControl } from './body-paragraphs.ts';
import { charLength } from './chars.ts';
import { parseJson } from './json.ts';
import { ensureTitleStyle, NORMAL_STYLE, paragraphStyles, resetToStyle, styleById, type ParagraphStyle } from './styles.ts';

const S_FIRST = 0;

export interface TableSpec {
  rows: number;
  cols: number;
  /** 행 × 열 글자. 칸 글자의 줄바꿈은 칸 안 문단으로 나눈다 */
  cells?: string[][];
  /** 첫 행을 머리글로: 한글 "제목 셀"(isHeader) + 쪽을 넘기면 머리글 반복(repeatHeader) + 굵은 글자 */
  header?: boolean;
}

export const MAX_TABLE_SIZE = 50;

function assertTableSpec({ rows, cols, cells }: TableSpec): void {
  const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_TABLE_SIZE;
  if (!inRange(rows) || !inRange(cols)) throw new Error(`표 크기는 행·열 1~${MAX_TABLE_SIZE} 입니다(행 ${rows}, 열 ${cols}).`);
  if (cells !== undefined && (cells.length !== rows || cells.some((row) => row.length !== cols))) {
    throw new Error(`cells 크기가 ${rows}×${cols} 와 다릅니다.`);
  }
}

const createdTableSchema = z.object({ paraIdx: z.number(), controlIdx: z.number() });
const cellPropsSchema = z.looseObject({ isHeader: z.boolean() });
const controlPositionsSchema = z.array(z.number());

/** 글자도 컨트롤도 없는 문단인지(rhwp 가 표 아래 덧붙인 빈 문단 확인용) */
const isBareParagraph = (doc: HwpDocument, section: number, paragraph: number) =>
  doc.getParagraphLength(section, paragraph) === 0 &&
  parseJson(controlPositionsSchema, doc.getControlTextPositions(section, paragraph)).length === 0;

/**
 * 기준 문단 뒤(after)·앞(before)에 새 문단을 만들고 rows×cols 표를 넣는다. 표가 든 문단 번호와 컨트롤 번호를 돌려준다.
 * 표 너비는 쪽 본문 너비를 열 수로 똑같이 나눈 것(rhwp createTable 기본값)이다. 새로 생기는 문단은 표가 든 문단 하나다.
 * 중간에 실패하면 넣은 문단·표를 스냅샷으로 되돌리고 던진다
 */
export function insertTableParagraph(
  doc: HwpDocument,
  section: number,
  reference: number,
  where: 'before' | 'after',
  spec: TableSpec,
): { paragraph: number; controlIndex: number } {
  assertTableSpec(spec);
  if (where === 'before' && reference === S_FIRST) throw new Error('구역 첫 문단 앞에는 표를 넣을 수 없습니다. 첫 문단 뒤에 넣으세요.');
  const snapshot = doc.saveSnapshot();
  try {
    const table = insertTable(doc, section, where === 'before' ? reference : reference + 1, spec);
    doc.discardSnapshot(snapshot);
    return table;
  } catch (error) {
    doc.restoreSnapshot(snapshot);
    doc.discardSnapshot(snapshot);
    throw error;
  }
}

function insertTable(doc: HwpDocument, section: number, at: number, spec: TableSpec): { paragraph: number; controlIndex: number } {
  doc.insertParagraph(section, at);
  // 새 문단은 앞 문단의 문단 모양(개요 등)·끝 글자 모양(굵게 등)을 물려받고, 표 문단·칸·표 아래 빈 문단이
  // 그것을 다시 물려받는다 → 바탕글 모양 그대로로
  resetToStyle(doc, section, at, styleById(doc, NORMAL_STYLE));
  const countBefore = doc.getParagraphCount(section);
  // 빈 문단에 넣으면 rhwp 는 그 문단을 표 문단으로 바꾸고 표 아래에 빈 문단 하나를 더한다(0.8.7)
  const created = parseJson(createdTableSchema, doc.createTable(section, at, 0, spec.rows, spec.cols));
  if (created.paraIdx !== at) throw new Error(`표가 예상한 문단(${at})이 아니라 ${created.paraIdx} 에 들어갔습니다.`);
  // 덧붙인 빈 문단이 확실할 때만 지운다(문단이 하나 늘었고 표 바로 뒤가 글자·컨트롤 없는 문단). 아니면 사용자 문단일 수 있어 둔다
  if (doc.getParagraphCount(section) === countBefore + 1 && isBareParagraph(doc, section, at + 1)) doc.deleteParagraph(section, at + 1);
  const table = { paragraph: created.paraIdx, controlIndex: created.controlIdx };
  if (spec.cells !== undefined) fillCells(doc, section, table, spec.cells);
  if (spec.header === true) markHeaderRow(doc, section, table, spec.cols);
  return table;
}

/** 칸 글자를 채운다(칸 번호 = 행 × 열 수 + 열). 줄바꿈마다 칸 안 문단을 나눈다 */
function fillCells(doc: HwpDocument, section: number, table: { paragraph: number; controlIndex: number }, cells: string[][]): void {
  cells.flat().forEach((text, cell) => {
    text.split(/\r\n|\r|\n/).forEach((line, cellPara) => {
      if (cellPara > 0) {
        const end = doc.getCellParagraphLength(section, table.paragraph, table.controlIndex, cell, cellPara - 1);
        doc.splitParagraphInCell(section, table.paragraph, table.controlIndex, cell, cellPara - 1, end);
      }
      if (line.length > 0) doc.insertTextInCell(section, table.paragraph, table.controlIndex, cell, cellPara, 0, line);
    });
  });
}

/** 첫 행을 머리글로: 칸 "제목 셀" 속성, 표 "머리글 반복", 칸 글자 굵게 */
function markHeaderRow(doc: HwpDocument, section: number, table: { paragraph: number; controlIndex: number }, cols: number): void {
  const { paragraph, controlIndex } = table;
  for (let cell = 0; cell < cols; cell += 1) {
    doc.setCellProperties(section, paragraph, controlIndex, cell, JSON.stringify({ isHeader: true }));
    const paragraphs = doc.getCellParagraphCount(section, paragraph, controlIndex, cell);
    for (let cellPara = 0; cellPara < paragraphs; cellPara += 1) {
      const length = doc.getCellParagraphLength(section, paragraph, controlIndex, cell, cellPara);
      if (length > 0) doc.applyCharFormatInCell(section, paragraph, controlIndex, cell, cellPara, 0, length, JSON.stringify({ bold: true }));
    }
  }
  doc.setTableProperties(section, paragraph, controlIndex, JSON.stringify({ repeatHeader: true }));
}

/** 칸이 머리글(제목 셀)인지 */
export const isHeaderCell = (doc: HwpDocument, section: number, paragraph: number, controlIndex: number, cell: number) =>
  parseJson(cellPropsSchema, doc.getCellProperties(section, paragraph, controlIndex, cell)).isHeader;

// 양식 본문 비우기 ---------------------------------------------------------------------------------

/** 남길 문단을 정하는 개체: 구역·단 정의, 머리말·꼬리말, 쪽 번호 위치. 이것이 든 문단은 지우지 않고 글자·다른 개체만 지운다 */
const KEEP_CONTROLS = new Set(['secd', 'cold', 'head', 'foot', 'pgnp']);


export interface ClearedBody {
  /** 남긴 문단(구역, 문단 — 비운 뒤 위치) */
  keptParagraphs: { section: number; paragraph: number }[];
  /** 지운 개체 이름별 수(표·그림·글상자 등. 문단째 지운 것 포함) */
  removedObjects: Record<string, number>;
  /** 남긴 개체 이름별 수(머리말·꼬리말 등) */
  keptObjects: Record<string, number>;
}

/** 본문 문단 컨트롤을 구역마다 모은다 */
function bodyControlsBySection(doc: HwpDocument): BodyControl[][] {
  const bySection: BodyControl[][] = Array.from({ length: doc.getSectionCount() }, () => []);
  for (const controls of bodyControlsAt(doc).values()) for (const control of controls) bySection[control.section]?.push(control);
  return bySection;
}

const countInto = (counts: Record<string, number>, name: string) => {
  counts[name] = (counts[name] ?? 0) + 1;
};
const nameOf = ({ userDesc, ctrlId }: BodyControl) => userDesc || ctrlId || '누름틀';

/**
 * 양식 문서의 본문을 비운다. 스타일·쪽 설정·머리말·꼬리말은 문서 정의·구역 첫 문단에 있어 그대로 남는다.
 * - 남길 개체(KEEP_CONTROLS)가 든 문단과 구역 첫 문단: 다른 개체와 글자를 지우고 바탕글 모양(문단·글자)으로 맞춘다
 * - 그 밖의 문단: 남길 문단 사이의 이어진 문단을 deleteRange 한 번으로 지운다(든 표·그림·글상자도 같이).
 *   문단마다 deleteParagraph 하면 지울 때마다 다시 조판해 74쪽 문서에서 13초가 걸렸다
 */
export function clearTemplateBody(doc: HwpDocument): ClearedBody {
  const result: ClearedBody = { keptParagraphs: [], removedObjects: {}, keptObjects: {} };
  const bySection = bodyControlsBySection(doc);
  for (let section = doc.getSectionCount() - 1; section >= 0; section -= 1) {
    const controls = bySection[section] ?? [];
    const count = doc.getParagraphCount(section);
    const keptSet = new Set([S_FIRST]);
    for (const control of controls) if (KEEP_CONTROLS.has(control.ctrlId)) keptSet.add(control.paragraph);
    const kept = [...keptSet].sort((x, y) => x - y);
    for (const control of controls) {
      countInto(KEEP_CONTROLS.has(control.ctrlId) ? result.keptObjects : result.removedObjects, nameOf(control));
    }
    // 남길 문단 k 뒤의 지울 문단 [k+1, next) 을 뒤에서부터: k 끝 ~ next-1 끝을 지우면 그 문단들이 k 에 합쳐지며 사라진다
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      const from = kept[i] ?? S_FIRST;
      const last = (kept[i + 1] ?? count) - 1;
      if (last > from) doc.deleteRange(section, from, doc.getParagraphLength(section, from), last, doc.getParagraphLength(section, last));
    }
    // 남긴 문단은 이제 0, 1, … 이다. 남길 개체 밖의 컨트롤(같은 문단의 표·그림 등)과 글자를 지운다
    const remaining = bodyControlsBySection(doc)[section] ?? [];
    for (let paragraph = 0; paragraph < kept.length; paragraph += 1) {
      const removable = remaining
        .filter((control) => control.paragraph === paragraph && !KEEP_CONTROLS.has(control.ctrlId))
        .sort((x, y) => y.controlIndex - x.controlIndex);
      // 컨트롤 번호가 밀리지 않게 큰 번호부터. 본문 목록 안 문단 번호는 구역을 이어 센 번호(control.para)다
      for (const control of removable) doc.deleteControlAt(control.list, control.para, control.controlIndex);
      const length = doc.getParagraphLength(section, paragraph);
      if (length > 0) doc.deleteText(section, paragraph, 0, length);
      // 양식 첫 문단의 글자 모양(표지 큰 글씨 등)이 남으면 그 뒤에 쓰는 제목·문단이 그 모양을 따른다
      resetToStyle(doc, section, paragraph, styleById(doc, NORMAL_STYLE));
      result.keptParagraphs.push({ section, paragraph });
    }
  }
  result.keptParagraphs.sort((x, y) => x.section - y.section || x.paragraph - y.paragraph);
  return result;
}

/** 본문 글자 수(모든 구역). 비운 뒤 0 인지 볼 때 */
export function bodyTextLength(doc: HwpDocument): number {
  let total = 0;
  for (let section = 0; section < doc.getSectionCount(); section += 1) {
    for (let paragraph = 0; paragraph < doc.getParagraphCount(section); paragraph += 1) {
      total += charLength(doc.getTextRange(section, paragraph, 0, doc.getParagraphLength(section, paragraph)));
    }
  }
  return total;
}

// 새 문서 만들기(create_document, #36) -------------------------------------------------------------

/** rhwp 빈 문서 템플릿(blank2010.hwp, 구역·단 정의가 든 빈 문단 하나). createEmpty 는 구역·단 정의가 없어 쓰지 않는다(ADR 003) */
export function blankDocument(): HwpDocument {
  const doc = HwpDocument.createEmpty();
  try {
    doc.createBlankDocument();
    return doc;
  } catch (error) {
    doc.free();
    throw error;
  }
}

export interface CreatedDocument {
  doc: HwpDocument;
  /** 양식 본문을 비웠으면 지운 개체·남긴 개체(keepContent 나 빈 문서면 undefined) */
  cleared: ClearedBody | undefined;
}

/**
 * create_document 의 문서 만들기(뷰어·테스트 뷰어 공용). 양식이 없으면 빈 문서, 있으면 양식을 열어 본문을 비운다(keepContent 면 그대로).
 * 그다음 제목 스타일이 없으면 더한다. 실패하면 만든 문서를 닫고 던진다(양식을 rhwp 가 읽지 못함 등)
 */
export function createNewDocument(template: Uint8Array | undefined, keepContent: boolean): CreatedDocument {
  const doc = template === undefined ? blankDocument() : new HwpDocument(template);
  try {
    const cleared = template !== undefined && !keepContent ? clearTemplateBody(doc) : undefined;
    ensureTitleStyle(doc);
    return { doc, cleared };
  } catch (error) {
    doc.free();
    throw error;
  }
}

/**
 * 뷰어 create_document 의 결과(뷰어·테스트 뷰어 공용, shared/protocol createDocumentResultSchema 모양): 쪽 수, 블록 위치,
 * 문단 스타일, 양식을 비웠으면 지운 개체·남긴 개체
 */
export function createdDocumentResult(doc: HwpDocument, blocks: Block[], cleared: ClearedBody | undefined) {
  return {
    pageCount: doc.pageCount(),
    blocks: blocks.map((block) => blockPositionSchema.parse(block)),
    styles: styleSummaries(doc),
    ...(cleared === undefined ? {} : { cleared: { removedObjects: cleared.removedObjects, keptObjects: cleared.keptObjects } }),
  };
}

/** create_document 결과에 싣는 스타일 목록(이름·영문 이름·개요 수준). 스타일 id 는 문서 안 번호라 싣지 않는다 */
export const styleSummaries = (doc: HwpDocument): Omit<ParagraphStyle, 'id'>[] =>
  paragraphStyles(doc).map(({ name, englishName, outlineLevel }) =>
    outlineLevel === undefined ? { name, englishName } : { name, englishName, outlineLevel },
  );
