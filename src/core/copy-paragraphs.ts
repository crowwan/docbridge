// 문서 사이 문단·표 복사(SPEC-007 copy_blocks, ADR 004 — #62 기술 검증, #64 구현). 대상 탭이 편집 공용 경로 안에서 부른다(edit-operations.ts).
// 원본 탭이 보낸 HWPX 바이트를 대상 쪽에서 열어 rhwp importParagraphBlock 으로 가져오고,
// rhwp 동작이 스펙과 다른 곳만 바로잡는다(ADR 002·003 원칙 그대로):
// - 번호 정의·스타일을 "내용이 모두 같을 때만" 대상 것으로 다시 쓰고 아니면 새로 더한다
//   → 대상에 같은 모양의 번호 정의가 있으면 그것으로(넣는 자리 바로 앞 문단의 목록 우선 — 번호가 대상 위치를 따라 이어진다), 개요 문단은 대상 구역 개요 번호로
//   → 대상에 같은 이름 스타일이 있으면 그 스타일로(applyStyle — 스타일 모양이던 글자만 대상 스타일 모양, 직접 서식은 그대로)
//   → 그래서 아무도 쓰지 않게 된 복제 스타일("바탕글" 두 개 등)은 지운다. 지우면 표 칸 문단 번호가 어긋나는 경우는 "이름 사본N" 으로 바꾼다.
//     더한 스타일의 다음 스타일이 복제를 가리키면 먼저 대상의 같은 이름 스타일로 돌린다(rhwp deleteStyle 은 지운 스타일을 가리키던 다음 스타일을 바탕글로 바꾼다)
// 보정은 넣은 문단(과 그 안 표 칸 문단)만 본다 — 대상의 원래 문단은 원래 스타일 번호(더한 것보다 작다)만 쓰므로 큰 대상 문서를 훑지 않는다.
// 표 안 표의 칸 문단은 rhwp 에 스타일을 읽는 경로 API 가 없어 보지 않는다(ADR 004 "확인 못 한 것").
// 원본 핸들 만들기는 옮기기(edits.ts DEFAULT_COPIES)와 같은 순서: HWP 로 한 번 바꾼 사본 → HWPX 그대로.
import { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import { bodyControlsAt } from './body-paragraphs.ts';
import { moveRejectReason, type MoveRejection } from './edits.ts';
import { parseJson } from './json.ts';
import { positionKey } from './paragraph-changes.ts';
import { errorMessage } from '../shared/errors.ts';

/** 원본 HWPX 바이트 → 가져올 읽기 전용 핸들 */
export type OpenSource = (hwpx: Uint8Array) => HwpDocument;

// HWPX 로 연 핸들은 번호 정의(paraHead)를 가져오지 못해 번호 문단을 거부한다(rhwp "opaque HWPX paraHead").
// 한 번 HWP 로 바꿔 다시 열면 받는다. 그리기 개체 등 HWP 로 바꾸면 거부되는 문단은 HWPX 그대로 한 번 더 본다
export const DEFAULT_SOURCES: OpenSource[] = [
  (hwpx) => {
    const parsed = new HwpDocument(hwpx);
    try {
      return new HwpDocument(parsed.exportHwp());
    } finally {
      parsed.free();
    }
  },
  (hwpx) => new HwpDocument(hwpx),
];

export interface SourceRange {
  section: number;
  /** [start, end) — 원본 구역 안 이어진 문단 */
  start: number;
  end: number;
}

export interface TargetPlace {
  section: number;
  /** 이 문단 앞에 넣는다(1..문단 수, 문단 수면 맨 끝). 구역 첫 문단 앞(0)은 거부 */
  before: number;
}

export interface CopyCorrections {
  /** 대상 번호 정의로 다시 가리킨 번호·개요 문단 수 */
  numbering: number;
  /** 대상의 같은 이름 스타일로 다시 가리킨 문단 수(표 칸 문단 포함) */
  styles: number;
  /** 지운 복제 스타일 이름 */
  deletedStyles: string[];
  /** 지우지 못해(넣은 표 칸 문단이 더 뒤 번호 스타일을 써서 지우면 번호가 어긋난다) 이름을 바꾼 복제 스타일 "옛 이름 → 새 이름" */
  renamedStyles: string[];
  /** 보정 뒤에도 남은, rhwp 가 더한 스타일 이름(대상에 같은 이름이 없던 것, 지우지 못한 복제) */
  addedStyles: string[];
}

export type CopyResult =
  | { ok: true; inserted: { start: number; end: number }; corrections: CopyCorrections }
  | { ok: false; rejected: MoveRejection[] };

const importRequest = (from: SourceRange, to: TargetPlace, dryRun: boolean) =>
  JSON.stringify({
    request: { sourceSection: from.section, sourceStart: from.start, sourceEnd: from.end, targetSection: to.section, insertBefore: to.before, count: 1 },
    dryRun,
  });

const styleListSchema = z.array(z.object({ id: z.number(), name: z.string(), nextStyleId: z.number() }));
const styleAtSchema = z.object({ id: z.number(), name: z.string() });
const numberingListSchema = z.array(z.object({ id: z.number(), levelFormats: z.array(z.string()) }));
const paraPropsSchema = z.looseObject({ headType: z.string(), numberingId: z.number() });
const dimensionsSchema = z.object({ cellCount: z.number() });

/**
 * 원본 HWPX 바이트의 이어진 문단 [start, end) 를 대상 문서 before 문단 앞에 서식째 넣는다(원본은 그대로).
 * 거부되면(모든 원본 핸들에서) 대상은 그대로 두고 거부된 문단과 이유를 돌려준다.
 * 실행 중 예외는 그대로 던진다 — 되돌리기는 부르는 쪽 스냅샷이 맡는다(moveParagraphs 와 같다).
 */
export function copyParagraphs(
  target: HwpDocument,
  sourceHwpx: Uint8Array,
  from: SourceRange,
  to: TargetPlace,
  sources: OpenSource[] = DEFAULT_SOURCES,
): CopyResult {
  const count = target.getParagraphCount(to.section);
  if (!(from.start < from.end && 0 <= to.before && to.before <= count)) {
    throw new Error(`복사할 범위나 넣을 자리가 맞지 않습니다(원본 ${from.start}~${from.end}, 대상 앞 ${to.before}, 대상 문단 수 ${count}).`);
  }
  // 구역 첫 문단 앞에 넣으면 구역·단 정의가 둘째 문단에 남는다(옮기기·넣기와 같은 이유, ADR 002)
  if (to.before === 0) throw new Error('구역 첫 문단 앞에는 넣을 수 없습니다. 첫 문단 뒤에 넣으세요.');
  let rejected: MoveRejection[] = [];
  for (const open of sources) {
    let source: HwpDocument;
    try {
      source = open(sourceHwpx);
    } catch (error) {
      if (rejected.length === 0) rejected = [{ paragraph: from.start, reason: `원본 문서를 열지 못했습니다: ${errorMessage(error)}` }];
      continue;
    }
    try {
      const found = dryRunRejections(target, source, from, to);
      if (found.length > 0) {
        // 모두 거부되면 거부가 적은 쪽, 같으면 나중 핸들 쪽 이유(옮기기와 같다)
        if (rejected.length === 0 || found.length <= rejected.length) rejected = found;
        continue;
      }
      const before = { styles: styleNames(target), numberings: numberings(target), precedingNumbering: numberingAt(target, to.section, to.before - 1) };
      target.importParagraphBlock(source, importRequest(from, to, false));
      const inserted = { start: to.before, end: to.before + (from.end - from.start) };
      return { ok: true, inserted, corrections: correct(target, to.section, inserted, before) };
    } finally {
      source.free();
    }
  }
  return { ok: false, rejected };
}

function dryRunRejections(target: HwpDocument, source: HwpDocument, from: SourceRange, to: TargetPlace): MoveRejection[] {
  try {
    target.importParagraphBlock(source, importRequest(from, to, true));
    return [];
  } catch {
    // 범위 전체 dryRun 은 첫 거부만 알려준다. 문단마다 다시 물어 모두 모은다(edits.ts dryRunRejections 와 같다)
    const rejected: MoveRejection[] = [];
    for (let p = from.start; p < from.end; p += 1) {
      try {
        target.importParagraphBlock(source, importRequest({ ...from, start: p, end: p + 1 }, to, true));
      } catch (error) {
        rejected.push({ paragraph: p, reason: moveRejectReason(errorMessage(error)) });
      }
    }
    return rejected.length > 0 ? rejected : [{ paragraph: from.start, reason: '범위를 한 번에 가져오지 못했습니다' }];
  }
}

const styleList = (doc: HwpDocument) => parseJson(styleListSchema, doc.getStyleList());
const styleNames = (doc: HwpDocument) => styleList(doc).map(({ name }) => name);
const numberings = (doc: HwpDocument) => parseJson(numberingListSchema, doc.getNumberingList());
const styleAt = (doc: HwpDocument, section: number, paragraph: number) => parseJson(styleAtSchema, doc.getStyleAt(section, paragraph)).id;
const cellStyleAt = (doc: HwpDocument, section: number, { paragraph, control, cell, cellParagraph }: CellParagraph) =>
  parseJson(styleAtSchema, doc.getCellStyleAt(section, paragraph, control, cell, cellParagraph)).id;

/** 자동 번호 문단이면 그 번호 정의 id(넣는 자리 앞 문단의 목록을 이어 쓰려고 넣기 전에 읽는다) */
function numberingAt(doc: HwpDocument, section: number, paragraph: number): number | undefined {
  if (paragraph < 0) return undefined;
  const { headType, numberingId } = parseJson(paraPropsSchema, doc.getParaPropertiesAt(section, paragraph));
  return headType === 'Number' ? numberingId : undefined;
}

interface Before {
  styles: string[];
  numberings: z.infer<typeof numberingListSchema>;
  /** 넣는 자리 바로 앞 문단의 번호 정의(자동 번호 문단일 때) */
  precedingNumbering: number | undefined;
}

/** 넣은 문단(과 그 안 표 칸 문단)을 대상 번호 정의·스타일로 다시 가리키고, 쓰이지 않게 된 복제 스타일을 지운다 */
function correct(doc: HwpDocument, section: number, inserted: { start: number; end: number }, before: Before): CopyCorrections {
  const corrections: CopyCorrections = { numbering: 0, styles: 0, deletedStyles: [], renamedStyles: [], addedStyles: [] };
  const isAddedNumbering = (id: number) => id > before.numberings.length;
  const added = numberings(doc);
  const cells = tableCells(doc, section, inserted);

  for (let p = inserted.start; p < inserted.end; p += 1) {
    const { headType, numberingId } = parseJson(paraPropsSchema, doc.getParaPropertiesAt(section, p));
    if (!isAddedNumbering(numberingId)) continue;
    if (headType === 'Outline') {
      // rhwp 는 원본 구역의 개요 번호를 번호 정의로 복제해 붙인다 → 대상 구역 개요 번호(0)를 따르게
      doc.applyParaFormat(section, p, JSON.stringify({ numberingId: 0 }));
      corrections.numbering += 1;
    } else if (headType === 'Number') {
      const formats = JSON.stringify(added.find(({ id }) => id === numberingId)?.levelFormats);
      const same = before.numberings.filter(({ levelFormats }) => JSON.stringify(levelFormats) === formats).map(({ id }) => id);
      // 같은 모양이 여럿이면 넣는 자리 바로 앞 문단의 목록을 잇는다(PR #70 리뷰). 대상에 같은 모양이 없으면 새 번호 목록(1부터)
      const chosen = same.find((id) => id === before.precedingNumbering) ?? same[0];
      if (chosen === undefined) continue;
      doc.applyParaFormat(section, p, JSON.stringify({ numberingId: chosen }));
      corrections.numbering += 1;
    }
  }

  // 스타일: rhwp 가 더한 스타일(id ≥ 원래 개수)이 대상의 같은 이름 스타일이면 그 스타일로. 스타일 목록은 applyStyle 로 바뀌지 않아 한 번만 읽는다
  const names = styleNames(doc);
  const targetStyleOf = (styleId: number): number | undefined => {
    if (styleId < before.styles.length) return undefined;
    const same = before.styles.indexOf(names[styleId] ?? '');
    return same < 0 ? undefined : same;
  };
  for (let p = inserted.start; p < inserted.end; p += 1) {
    const to = targetStyleOf(styleAt(doc, section, p));
    if (to === undefined) continue;
    doc.applyStyle(section, p, to);
    corrections.styles += 1;
  }
  for (const cell of cells) {
    const to = targetStyleOf(cellStyleAt(doc, section, cell));
    if (to === undefined) continue;
    doc.applyCellStyle(section, cell.paragraph, cell.control, cell.cell, cell.cellParagraph, to);
    corrections.styles += 1;
  }

  // 쓰이지 않게 된 복제 스타일 지우기. 대상의 원래 문단은 원래 번호(더한 것보다 작다)만 쓰므로 넣은 문단만 보면 된다.
  // rhwp deleteStyle 은 본문 문단의 스타일 번호만 당기고 표 칸 문단은 손대지 않아서,
  // 넣은 칸 문단이 지울 스타일보다 뒤 번호(남기는 새 스타일)를 쓰면 지우지 않는다
  const used = new Set<number>();
  for (let p = inserted.start; p < inserted.end; p += 1) used.add(styleAt(doc, section, p));
  const cellStyles = cells.map((cell) => cellStyleAt(doc, section, cell));
  cellStyles.forEach((id) => used.add(id));
  pointNextStylesAtTarget(doc, before.styles);
  // 지우지 못하는 복제는 한글이 붙여 넣을 때처럼 "이름 사본N" 으로 바꿔 같은 이름이 둘 남지 않게 한다
  for (let id = names.length - 1; id >= before.styles.length; id -= 1) {
    const name = names[id] ?? '';
    if (!before.styles.includes(name)) continue;
    if (!used.has(id) && !cellStyles.some((c) => c > id) && doc.deleteStyle(id)) {
      corrections.deletedStyles.unshift(name);
      continue;
    }
    const taken = new Set(styleNames(doc));
    let copyNumber = 1;
    while (taken.has(`${name} 사본${copyNumber}`)) copyNumber += 1;
    if (!doc.updateStyle(id, JSON.stringify({ name: `${name} 사본${copyNumber}` }))) {
      throw new Error(`복제 스타일 "${name}" 의 이름을 바꾸지 못했습니다(스타일 ${id}). 같은 이름 스타일이 둘 남아 복사하지 않았습니다.`);
    }
    corrections.renamedStyles.unshift(`${name} → ${name} 사본${copyNumber}`);
  }
  corrections.addedStyles = styleNames(doc).slice(before.styles.length);
  return corrections;
}

/**
 * 더한 스타일(복제가 아닌 것)의 다음 스타일이 복제 스타일(대상에 같은 이름이 있는 새 스타일)이면 대상의 같은 이름 스타일로 돌린다.
 * 복제를 지우면 rhwp 가 그 참조를 바탕글로 바꾸고, 지우지 못해 "사본N" 이 되면 다른 이름을 가리키게 된다. 복제 자신은 지우거나 사본이 되므로 그대로 둔다
 */
function pointNextStylesAtTarget(doc: HwpDocument, targetStyles: string[]): void {
  const list = styleList(doc);
  const targetOf = (styleId: number): number | undefined => {
    if (styleId < targetStyles.length) return undefined;
    const same = targetStyles.indexOf(list[styleId]?.name ?? '');
    return same < 0 ? undefined : same;
  };
  for (const { id, name, nextStyleId } of list.slice(targetStyles.length)) {
    if (targetStyles.includes(name)) continue;
    const next = targetOf(nextStyleId);
    if (next === undefined) continue;
    if (!doc.updateStyle(id, JSON.stringify({ nextStyleId: next }))) {
      throw new Error(`스타일 "${name}" 의 다음 스타일을 바꾸지 못했습니다(스타일 ${id}).`);
    }
  }
}

interface CellParagraph {
  paragraph: number;
  control: number;
  cell: number;
  cellParagraph: number;
}

/** 넣은 문단에 든 본문 표의 칸 문단 위치(한 겹 — 표 안 표는 보지 않는다) */
function tableCells(doc: HwpDocument, section: number, inserted: { start: number; end: number }): CellParagraph[] {
  const controls = bodyControlsAt(doc);
  const cells: CellParagraph[] = [];
  for (let paragraph = inserted.start; paragraph < inserted.end; paragraph += 1) {
    for (const { ctrlId, controlIndex } of controls.get(positionKey({ section, paragraph })) ?? []) {
      if (ctrlId !== 'tbl') continue;
      const { cellCount } = parseJson(dimensionsSchema, doc.getTableDimensions(section, paragraph, controlIndex));
      for (let cell = 0; cell < cellCount; cell += 1) {
        const count = doc.getCellParagraphCount(section, paragraph, controlIndex, cell);
        for (let cellParagraph = 0; cellParagraph < count; cellParagraph += 1) cells.push({ paragraph, control: controlIndex, cell, cellParagraph });
      }
    }
  }
  return cells;
}
