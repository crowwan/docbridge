// 새 문서 만들기 어댑터 — SPEC-003 기술 검증(#35)에서 확인한 절차를 함수로 둔다(ADR 003).
// rhwp 기본 동작이 스펙과 다른 곳만 바로잡는다(ADR 002 원칙 그대로):
// - createBlankDocument 의 스타일에는 "제목"이 없다 → "제목" 스타일이 없는 문서에 docbridge 제목 스타일을 하나 더한다
// - applyStyle 은 문단에 직접 문단 모양이 있으면 그 모양을 그대로 둔다(개요 번호가 안 붙는다) → 스타일의 문단 모양으로 맞춘다
// - createTable 은 표 문단·칸 문단·표 아래 빈 문단에 넣는 자리 문단 모양을 물려준다(개요 문단 뒤면 모두 개요 번호를 받는다)
//   → 새 문단을 바탕글로 맞춘 뒤 표를 넣고, rhwp 가 덧붙인 표 아래 빈 문단은 지운다
// - 양식 본문 비우기: 구역 첫 문단(구역·단 정의)과 머리말·꼬리말·쪽 번호 위치가 든 문단은 남기고 글자·다른 개체를 지운다
import type { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import { charLength } from './chars.ts';
import { parseJson } from './json.ts';

const S_FIRST = 0;
const NORMAL_STYLE = 0;

const styleListSchema = z.array(
  z.object({ id: z.number(), name: z.string(), englishName: z.string(), type: z.number(), paraShapeId: z.number() }),
);
const styleDetailSchema = z.object({
  paraProps: z.looseObject({ headType: z.string(), paraLevel: z.number() }),
});

export interface ParagraphStyle {
  id: number;
  name: string;
  englishName: string;
  /** 개요 스타일이면 개요 수준(1부터). 이 스타일 문단은 개요 번호를 받는다 */
  outlineLevel?: number;
}

/** rhwp getStyleList 의 type: 0 문단, 1 글자. 한컴 HWP 5 바이너리 일부는 다른 비트가 섞여 문단 스타일도 4·108 로 온다(로컬 한컴 문서 2개) */
const CHARACTER_STYLE = 1;

/**
 * 문서의 문단 스타일(글자 스타일 빼고). 개요 번호 여부는 스타일 이름이 아니라 스타일 문단 모양의 headType 으로 본다
 * (한컴 공문 양식은 "개요 1" 을 번호 없는 모양으로 바꿔 쓰기도 한다 — 로컬 한컴 기안문)
 */
export function paragraphStyles(doc: HwpDocument): ParagraphStyle[] {
  return parseJson(styleListSchema, doc.getStyleList())
    .filter(({ type }) => type !== CHARACTER_STYLE)
    .map(({ id, name, englishName }) => {
      const { paraProps } = parseJson(styleDetailSchema, doc.getStyleDetail(id));
      return paraProps.headType === 'Outline'
        ? { id, name, englishName, outlineLevel: paraProps.paraLevel + 1 }
        : { id, name, englishName };
    });
}

/** 스타일 이름(한글 이름 또는 영문 이름) → id. 없으면 던진다 */
export function styleIdByName(doc: HwpDocument, name: string): number {
  const found = paragraphStyles(doc).find((style) => style.name === name || style.englishName === name);
  if (found === undefined) throw new Error(`없는 스타일입니다: ${name}. list_styles 로 목록을 보세요.`);
  return found.id;
}

const styleParaShapeId = (doc: HwpDocument, styleId: number): number | undefined =>
  parseJson(styleListSchema, doc.getStyleList()).find(({ id }) => id === styleId)?.paraShapeId;

const paraShapeIdSchema = z.looseObject({ paraShapeId: z.number() });
const paraShapeIdAt = (doc: HwpDocument, section: number, paragraph: number) =>
  parseJson(paraShapeIdSchema, doc.getParaPropertiesAt(section, paragraph)).paraShapeId;

/**
 * 본문 문단에 문단 스타일을 건다. 문단 모양은 스타일 것으로 맞추고(직접 문단 모양은 버린다),
 * 글자 모양은 rhwp 대로 스타일 글자 모양이던 글자만 새 스타일 글자 모양이 되고 직접 서식(굵게 등)은 남는다
 */
export function applyParagraphStyle(doc: HwpDocument, section: number, paragraph: number, styleId: number): void {
  doc.applyStyle(section, paragraph, styleId);
  const shape = styleParaShapeId(doc, styleId);
  // rhwp applyStyle 은 문단 모양이 옛 스타일 것과 다르면(직접 문단 모양) 그대로 둔다 → 개요 스타일이어도 번호가 안 붙는다
  if (shape !== undefined && paraShapeIdAt(doc, section, paragraph) !== shape) doc.setParaShapeId(section, paragraph, shape);
}

/** docbridge 가 "제목" 스타일이 없는 문서에 더하는 제목 스타일(빈 문서 템플릿에는 "제목"이 없다). 가운데 정렬, 20pt 굵게, 다음 문단은 본문 */
export const TITLE_STYLE = { name: '제목', englishName: 'Title', fontSize: 2000 } as const;

/** 제목 스타일이 없으면 만든다. 스타일 id 를 돌려준다 */
export function ensureTitleStyle(doc: HwpDocument): number {
  const existing = paragraphStyles(doc).find(({ name }) => name === TITLE_STYLE.name);
  if (existing !== undefined) return existing.id;
  const body = paragraphStyles(doc).find(({ englishName }) => englishName === 'Body')?.id ?? NORMAL_STYLE;
  const id = doc.createStyle(JSON.stringify({ name: TITLE_STYLE.name, englishName: TITLE_STYLE.englishName, type: 0, nextStyleId: body }));
  if (!doc.updateStyleShapes(id, JSON.stringify({ fontSize: TITLE_STYLE.fontSize, bold: true }), JSON.stringify({ alignment: 'center' }))) {
    throw new Error('제목 스타일의 모양을 정하지 못했습니다.');
  }
  return id;
}

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

/**
 * 기준 문단 뒤(after)·앞(before)에 새 문단을 만들고 rows×cols 표를 넣는다. 표가 든 문단 번호와 컨트롤 번호를 돌려준다.
 * 표 너비는 쪽 본문 너비를 열 수로 똑같이 나눈 것(rhwp createTable 기본값)이다. 새로 생기는 문단은 표가 든 문단 하나다
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
  const at = where === 'before' ? reference : reference + 1;
  doc.insertParagraph(section, at);
  // 새 문단은 앞 문단 모양(개요 등)을 물려받고, 표 문단·칸 문단·표 아래 빈 문단이 그것을 다시 물려받는다 → 바탕글로
  applyParagraphStyle(doc, section, at, NORMAL_STYLE);
  // 빈 문단에 넣으면 rhwp 는 그 문단을 표 문단으로 바꾸고 표 아래에 빈 문단 하나를 더한다
  const created = parseJson(createdTableSchema, doc.createTable(section, at, 0, spec.rows, spec.cols));
  if (created.paraIdx !== at) throw new Error(`표가 예상한 문단(${at})이 아니라 ${created.paraIdx} 에 들어갔습니다.`);
  doc.deleteParagraph(section, at + 1);
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

const controlListSchema = z.array(
  z.object({ ctrlId: z.string(), userDesc: z.string(), list: z.number(), para: z.number(), controlIndex: z.number() }),
);
type ControlInfo = z.infer<typeof controlListSchema>[number];

export interface ClearedBody {
  /** 남긴 문단(구역, 문단 — 비운 뒤 위치) */
  keptParagraphs: { section: number; paragraph: number }[];
  /** 지운 개체 이름별 수(표·그림·글상자 등. 문단째 지운 것 포함) */
  removedObjects: Record<string, number>;
  /** 남긴 개체 이름별 수(머리말·꼬리말 등) */
  keptObjects: Record<string, number>;
}

/** 본문 컨트롤(목록 0)과 그 구역 안 문단 번호 */
interface BodyControl extends ControlInfo {
  section: number;
  paragraph: number;
}

/**
 * 본문 문단 컨트롤을 구역마다 모은다. getControls 는 본문을 목록 0 하나로 보고 문단 번호를 구역을 이어 센다
 * (blocks.ts tablesByParagraph 와 같은 방법 — 구역마다 다른 목록이 아니다, 여러 구역 한컴 문서로 확인)
 */
function bodyControlsBySection(doc: HwpDocument): BodyControl[][] {
  const starts: number[] = [];
  let total = 0;
  for (let section = 0; section < doc.getSectionCount(); section += 1) {
    starts.push(total);
    total += doc.getParagraphCount(section);
  }
  const bySection: BodyControl[][] = starts.map(() => []);
  for (const control of parseJson(controlListSchema, doc.getControls())) {
    if (control.list !== 0) continue;
    const section = starts.findLastIndex((start) => start <= control.para);
    bySection[section]?.push({ ...control, section, paragraph: control.para - (starts[section] ?? 0) });
  }
  return bySection;
}

const countInto = (counts: Record<string, number>, name: string) => {
  counts[name] = (counts[name] ?? 0) + 1;
};
const nameOf = ({ userDesc, ctrlId }: ControlInfo) => userDesc || ctrlId || '누름틀';

/**
 * 양식 문서의 본문을 비운다. 스타일·쪽 설정·머리말·꼬리말은 문서 정의·구역 첫 문단에 있어 그대로 남는다.
 * - 남길 개체(KEEP_CONTROLS)가 든 문단과 구역 첫 문단: 다른 개체와 글자를 지우고 바탕글로 맞춘다
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
      // 컨트롤 번호가 밀리지 않게 큰 번호부터. 본문 목록(0) 안 문단 번호는 구역을 이어 센 번호(control.para)다
      for (const control of removable) doc.deleteControlAt(control.list, control.para, control.controlIndex);
      const length = doc.getParagraphLength(section, paragraph);
      if (length > 0) doc.deleteText(section, paragraph, 0, length);
      applyParagraphStyle(doc, section, paragraph, NORMAL_STYLE);
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
