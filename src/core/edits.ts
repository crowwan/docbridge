// rhwp 편집 어댑터 — SPEC-002 기술 검증(#18)에서 확인한 절차를 함수로 둔다.
// 서식은 rhwp 에 맡기되, rhwp 기본 동작이 스펙과 다른 곳만 여기서 바로잡는다(ADR 002).
// - replaceText 는 지우고 넣는데, 넣은 글자가 **앞 글자** 모양을 따른다 → 첫 글자 뒤에 넣고 첫 글자를 지운다
// - setFieldValue 도 값의 글자 모양을 버린다 → 값이 있으면 같은 방법으로 바꾼다
// - insertParagraph 는 **앞 문단** 모양을 물려준다 → 기준 문단 모양으로 다시 맞춘다
// - importParagraphBlock 은 다른 핸들에서 가져오면서 번호 정의를 새로 만든다(번호가 1부터 다시 시작) → 원래 문단 모양 번호로 되돌린다
// 글자 위치는 모두 유니코드 글자 단위(rhwp 와 같다, chars.ts).
import { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import { parseJson } from './json.ts';
import { errorMessage } from '../shared/errors.ts';
import { charLength, sliceChars } from './chars.ts';

/** 문단 하나(본문 또는 칸 안)의 글자를 넣고 지우는 손잡이 */
interface TextSpot {
  length(): number;
  insert(offset: number, text: string): void;
  remove(offset: number, count: number): void;
  /** offset 글자의 글자 속성 JSON */
  look(offset: number): string;
  /** [start, end) 에 글자 속성을 건다(같은 속성의 새 글자 모양 id 가 생길 수 있다) */
  applyLook(start: number, end: number, look: string): void;
}

function bodySpot(doc: HwpDocument, section: number, paragraph: number): TextSpot {
  return {
    length: () => doc.getParagraphLength(section, paragraph),
    insert: (offset, text) => void doc.insertText(section, paragraph, offset, text),
    remove: (offset, count) => void doc.deleteText(section, paragraph, offset, count),
    look: (offset) => doc.getCharPropertiesAt(section, paragraph, offset),
    applyLook: (start, end, look) => void doc.applyCharFormat(section, paragraph, start, end, look),
  };
}

/** 칸 경로: 바깥 표부터 [표 컨트롤 번호, 칸 번호, 칸 안 문단 번호] */
export interface CellStep {
  controlIndex: number;
  cellIndex: number;
  cellParaIndex: number;
}

function cellSpot(doc: HwpDocument, section: number, paragraph: number, path: CellStep[]): TextSpot {
  const pathJson = JSON.stringify(path);
  return {
    length: () => doc.getCellParagraphLengthByPath(section, paragraph, pathJson),
    insert: (offset, text) => void doc.insertTextInCellByPath(section, paragraph, pathJson, offset, text),
    remove: (offset, count) => void doc.deleteTextInCellByPath(section, paragraph, pathJson, offset, count),
    look: (offset) => doc.getCellCharPropertiesAtByPath(section, paragraph, pathJson, offset),
    applyLook: (start, end, look) => void doc.applyCharFormatInCellByPath(section, paragraph, pathJson, start, end, look),
  };
}

/**
 * 문단 하나 안에서 [start, end) 를 text 로 바꾼다. 바뀐 글자는 바뀌는 자리 **첫 글자** 모양을 따른다.
 * rhwp 의 넣기는 앞 글자 모양을 물려주므로, 첫 글자 바로 뒤에 넣고 나머지와 첫 글자를 지운다.
 * 빈 범위(start === end)는 그 자리 앞 글자 모양으로 넣는다(따를 첫 글자가 없다).
 */
function replaceInSpot(spot: TextSpot, start: number, end: number, text: string): void {
  if (start === end) {
    if (text.length > 0) spot.insert(start, text);
    return;
  }
  const newLength = charLength(text);
  if (newLength > 0) spot.insert(start + 1, text);
  // [첫 글자][새 글자][나머지 옛 글자] → 나머지 옛 글자, 첫 글자 순서로 지운다
  const restStart = start + 1 + newLength;
  const restCount = end - start - 1;
  if (restCount > 0) spot.remove(restStart, restCount);
  spot.remove(start, 1);
}

function assertRange(start: number, end: number, length: number, where: string): void {
  if (!(Number.isInteger(start) && Number.isInteger(end) && 0 <= start && start <= end && end <= length)) {
    throw new Error(`${where}: 글자 범위가 맞지 않습니다(start ${start}, end ${end}, 글자 수 ${length}).`);
  }
}

const REPLACE_NEWLINE = '바꿀 글자에 줄바꿈이 있습니다. 새 문단은 insert_paragraph 로 넣으세요.';
const INSERT_NEWLINE = '넣을 글자에 줄바꿈이 있습니다. 문단을 여럿 넣으려면 insert_paragraph 를 문단마다 부르세요.';

function assertSingleLine(text: string, message = REPLACE_NEWLINE): void {
  if (/[\r\n]/.test(text)) throw new Error(message);
}

/** 본문 문단의 [start, end) 를 바꾼다. end 를 빼면 문단 끝까지 */
export function replaceParagraphText(
  doc: HwpDocument,
  section: number,
  paragraph: number,
  text: string,
  start = 0,
  end?: number,
): void {
  assertSingleLine(text);
  const spot = bodySpot(doc, section, paragraph);
  const to = end ?? spot.length();
  assertRange(start, to, spot.length(), `문단 ${section}:${paragraph}`);
  replaceInSpot(spot, start, to, text);
}

export interface CellAddress {
  section: number;
  /** 표를 품은 본문 문단 */
  paragraph: number;
  controlIndex: number;
  cellIndex: number;
}

/**
 * 표 칸의 [start, end) 를 바꾼다. 위치는 칸 text(칸 안 문단을 \n 으로 이은 것) 기준이고, end 를 빼면 칸 끝까지.
 * 범위가 칸 안 여러 문단에 걸치면 그 문단들을 합친다(사이 \n 이 지워진다).
 */
export function replaceCellText(doc: HwpDocument, cell: CellAddress, text: string, start = 0, end?: number): void {
  assertSingleLine(text);
  const { section, paragraph, controlIndex, cellIndex } = cell;
  const lengths = Array.from({ length: doc.getCellParagraphCount(section, paragraph, controlIndex, cellIndex) }, (_, p) =>
    doc.getCellParagraphLength(section, paragraph, controlIndex, cellIndex, p),
  );
  const total = lengths.reduce((sum, length) => sum + length, 0) + Math.max(0, lengths.length - 1);
  const to = end ?? total;
  assertRange(start, to, total, `칸 ${cellIndex}`);
  const from = cellOffset(lengths, start);
  const until = cellOffset(lengths, to);
  const spot = cellSpot(doc, section, paragraph, [{ controlIndex, cellIndex, cellParaIndex: from.paragraph }]);
  if (from.paragraph === until.paragraph) {
    replaceInSpot(spot, from.offset, until.offset, text);
    return;
  }
  // 여러 문단: 첫 문단 안에서 첫 글자 뒤에 넣고, 넣은 글자 뒤부터 끝 위치까지 지운 뒤(문단이 합쳐진다) 첫 글자를 지운다
  const firstIsChar = from.offset < (lengths[from.paragraph] ?? 0);
  const insertAt = firstIsChar ? from.offset + 1 : from.offset;
  if (text.length > 0) spot.insert(insertAt, text);
  doc.deleteRangeInCell(
    section,
    paragraph,
    controlIndex,
    cellIndex,
    from.paragraph,
    insertAt + charLength(text),
    until.paragraph,
    until.offset,
  );
  if (firstIsChar) spot.remove(from.offset, 1);
}

/** 칸 text 의 글자 위치 → (칸 안 문단, 문단 안 위치). 문단 사이 \n 위치는 앞 문단 끝으로 본다 */
function cellOffset(lengths: number[], position: number): { paragraph: number; offset: number } {
  let rest = position;
  for (const [paragraph, length] of lengths.entries()) {
    if (rest <= length) return { paragraph, offset: rest };
    rest -= length + 1;
  }
  return { paragraph: Math.max(0, lengths.length - 1), offset: lengths.at(-1) ?? 0 };
}

// getFieldList 의 location.path 한 칸. 표 칸은 칸 번호가 있고, 글상자 등 칸이 아닌 자리는 칸 번호가 없다
// ({type:"textbox", controlIndex, paraIndex}, #42). 칸이 아닌 자리는 종류와 컨트롤 번호만 읽는다
const cellPathStepSchema = z.object({ type: z.literal('cell'), controlIndex: z.number(), cellIndex: z.number(), paraIndex: z.number() });
const otherPathStepSchema = z.object({ type: z.string(), controlIndex: z.number() });
// 하이퍼링크 등 누름틀이 아닌 필드는 모양이 달라도 던지지 않게 종류만 먼저 읽고 거른다(#42)
const fieldKindListSchema = z.array(z.looseObject({ fieldType: z.string() }));
const clickHereListSchema = z.array(
  z.object({
    fieldId: z.number(),
    fieldType: z.string(),
    name: z.string(),
    value: z.string(),
    startCharIdx: z.number(),
    endCharIdx: z.number(),
    location: z.object({
      sectionIndex: z.number(),
      paraIndex: z.number(),
      path: z.array(z.union([cellPathStepSchema, otherPathStepSchema])).optional(),
    }),
  }),
);

export type FieldInfo = z.infer<typeof clickHereListSchema>[number];

/** 누름틀만. 표 칸 안 누름틀은 path 가 칸 번호(cellIndex)를 가진다 */
export function listFields(doc: HwpDocument): FieldInfo[] {
  const clickHeres = parseJson(fieldKindListSchema, doc.getFieldList()).filter((field) => field.fieldType === 'clickhere');
  return clickHereListSchema.parse(clickHeres);
}

/**
 * 누름틀 값을 바꾼다. 값이 있으면 값 첫 글자 모양을 따른다(setFieldValue 는 값의 글자 모양을 버려서 쓰지 않는다).
 * 값이 비어 있으면 따를 글자가 없으므로 setFieldValue 로 넣는다(누름틀 앞 글자 모양).
 * start·end 는 값 안 위치. 없으면 값 전체.
 */
export function replaceFieldText(doc: HwpDocument, fieldId: number, text: string, start = 0, end?: number): void {
  assertSingleLine(text);
  const field = listFields(doc).find((candidate) => candidate.fieldId === fieldId);
  if (field === undefined) throw new Error(`없는 누름틀입니다(fieldId ${fieldId}).`);
  const length = charLength(field.value);
  const to = end ?? length;
  assertRange(start, to, length, `누름틀 ${field.name}`);
  if (length === 0) {
    doc.setFieldValue(fieldId, text);
    return;
  }
  const { sectionIndex, paraIndex, path = [] } = field.location;
  const cells = path.flatMap((step) =>
    'cellIndex' in step ? [{ controlIndex: step.controlIndex, cellIndex: step.cellIndex, cellParaIndex: step.paraIndex }] : [],
  );
  if (cells.length !== path.length) throw new Error(`글상자 안 누름틀 ${field.name} 은 아직 바꿀 수 없습니다.`);
  const spot = cells.length === 0 ? bodySpot(doc, sectionIndex, paraIndex) : cellSpot(doc, sectionIndex, paraIndex, cells);
  const at = field.startCharIdx;
  const appending = start === to && start === length;
  const prepending = start === to && start === 0;
  if ((appending || prepending) && length === 1) {
    // 한 글자 값 앞·뒤에는 누름틀 안쪽 넣을 자리가 없다 → 값을 통째로 넣고 그 글자 모양을 속성으로 다시 건다
    const look = spot.look(at);
    doc.setFieldValue(fieldId, appending ? field.value + text : text + field.value);
    spot.applyLook(at, at + length + charLength(text), look);
  } else if (appending) {
    // 값 끝 위치에 넣으면 누름틀 밖으로 나간다 → 마지막 두 글자를 "두 글자 + 글자" 로 바꾼다(넣는 자리가 값 안쪽)
    replaceInSpot(spot, at + length - 2, at + length, sliceChars(field.value, length - 2) + text);
  } else if (prepending) {
    // 값 첫 자리도 누름틀 밖이다 → 첫 글자를 "글자 + 첫 글자" 로 바꾼다(붙인 글자는 값 첫 글자 모양)
    replaceInSpot(spot, at, at + 1, text + sliceChars(field.value, 0, 1));
  } else {
    replaceInSpot(spot, at + start, at + to, text);
  }
  const after = listFields(doc).find((candidate) => candidate.fieldId === fieldId);
  const expected = sliceChars(field.value, 0, start) + text + sliceChars(field.value, to);
  if (after?.value !== expected) {
    throw new Error(`누름틀 ${field.name} 값이 기대와 다릅니다(기대 "${expected}", 실제 "${after?.value ?? '(없음)'}").`);
  }
}

const paraShapeSchema = z.object({ paraShapeId: z.number() });
const charPropsSchema = z.looseObject({ charShapeId: z.number() });

export const paraShapeIdOf = (doc: HwpDocument, section: number, paragraph: number) =>
  parseJson(paraShapeSchema, doc.getParaPropertiesAt(section, paragraph)).paraShapeId;

/**
 * 글자 모양 비교용: 보이는 속성 JSON. 글자 모양 id 와 테두리·배경 id 는 뺀다(테두리·배경은 값으로 들어 있다).
 * 문단을 옮기면 rhwp 가 글자 모양·테두리를 같은 값의 새 id 로 다시 매기기 때문이다(ADR 002)
 */
export function charLook(doc: HwpDocument, section: number, paragraph: number, offset: number): string {
  const { charShapeId: _id, borderFillId: _border, ...look } = parseJson(charPropsSchema, doc.getCharPropertiesAt(section, paragraph, offset));
  return JSON.stringify(look);
}

/**
 * 기준 문단 앞(before)·뒤(after)에 새 문단을 넣고 text 를 채운다. 새 문단 번호를 돌려준다.
 * 문단 모양은 기준 문단을 따른다. 글자 모양은 앞에 넣으면 기준 문단 첫 글자, 뒤에 넣으면 마지막 글자를 따른다
 * (한글에서 문단 처음·끝에서 Enter 를 친 것과 같다).
 */
export function insertParagraphNear(
  doc: HwpDocument,
  section: number,
  reference: number,
  where: 'before' | 'after',
  text: string,
): number {
  assertSingleLine(text, INSERT_NEWLINE);
  // 구역 첫 문단 앞에 넣으면 구역·단 정의가 둘째 문단에 남고, HWPX 로 저장해 다시 열면 구역 정의가 둘이 된다(ADR 002)
  if (where === 'before' && reference === 0) throw new Error('구역 첫 문단 앞에는 문단을 넣을 수 없습니다. 첫 문단 뒤에 넣으세요.');
  const at = where === 'before' ? reference : reference + 1;
  const referenceShape = paraShapeIdOf(doc, section, reference);
  const referenceLength = doc.getParagraphLength(section, reference);
  const lookOffset = where === 'before' ? 0 : Math.max(0, referenceLength - 1);
  const referenceLook = referenceLength > 0 ? doc.getCharPropertiesAt(section, reference, lookOffset) : undefined;
  // insertParagraph(at) 은 at-1 문단 모양과 끝 글자 모양을 물려준다. 뒤에 넣을 때는 기준 문단이 at-1 이라 그대로 맞다
  doc.insertParagraph(section, at);
  const shiftedReference = where === 'before' ? reference + 1 : reference;
  if (paraShapeIdOf(doc, section, at) !== referenceShape) doc.setParaShapeId(section, at, referenceShape);
  // 빈 문단도 글자 모양을 맞추려고 자리 글자 하나를 넣었다가 지운다(빈 문단은 마지막 글자 모양을 남긴다)
  const filled = text.length > 0 ? text : ' ';
  doc.insertText(section, at, 0, filled);
  if (referenceLook !== undefined && charLook(doc, section, at, 0) !== charLook(doc, section, shiftedReference, lookOffset)) {
    // 글자 모양 id 를 직접 정하는 API 가 없어 속성으로 건다(같은 속성의 새 id 가 생길 수 있다)
    doc.applyCharFormat(section, at, 0, charLength(filled), referenceLook);
  }
  if (text.length === 0) doc.deleteText(section, at, 0, 1);
  return at;
}

/** 블록 복제가 거부한 문단과 이유 */
export interface MoveRejection {
  /** 구역 안 문단 번호 */
  paragraph: number;
  reason: string;
}

export type MoveResult =
  | { ok: true; /** 옮긴 뒤 문단 범위 [start, end) */ moved: { start: number; end: number } }
  | { ok: false; rejected: MoveRejection[] };

// rhwp 오류 "paragraph block unsupported at [Paragraph(0), Control(0)]: Footnote" 의 이유 → 사람이 읽는 이름
const REJECT_REASONS: Record<string, string> = {
  Footnote: '각주',
  Endnote: '미주',
  Bookmark: '책갈피',
  'uninterpreted CTRL_DATA payload': '책갈피 등 해석하지 못한 컨트롤 데이터',
  NewNumber: '새 번호로 시작',
  AutoNumber: '자동 번호(쪽 번호 등)',
  Hyperlink: '하이퍼링크',
  Chart: '차트',
  Ole: 'OLE 개체',
  Form: '양식 개체',
  HiddenComment: '숨은 설명',
  Ruby: '덧말',
  Header: '머리말',
  Footer: '꼬리말',
  SectionDef: '구역 정의',
  ColumnDef: '단 정의',
  'section/multicolumn paragraph boundary': '구역·단 시작 문단',
  PageNumberPos: '쪽 번호 위치',
  PageNumCtrl: '쪽 번호 제어',
  PageHide: '감추기',
  IndexMark: '찾아보기 표시',
  CharOverlap: '글자 겹치기',
};

/** rhwp 블록 복제 오류 문구 → 이유. 모르는 이유는 rhwp 문구 그대로 */
export function moveRejectReason(message: string): string {
  const reason = /unsupported at \[[^\]]*\]: (.+)$/.exec(message)?.[1] ?? /paragraph block: (.+)$/.exec(message)?.[1] ?? message;
  return REJECT_REASONS[reason.trim()] ?? reason.trim();
}

const importRequest = (section: number, start: number, end: number, before: number, dryRun: boolean) =>
  JSON.stringify({
    request: { sourceSection: section, sourceStart: start, sourceEnd: end, targetSection: section, insertBefore: before, count: 1 },
    dryRun,
  });

/** 옮기기에 쓸 사본 만들기(같은 핸들은 importParagraphBlock 이 받지 않는다) */
export type MakeCopy = (doc: HwpDocument) => HwpDocument;

// 사본은 HWP 로 먼저 만든다. HWPX 사본은 HWPX 번호 정의(paraHead)를 가져오지 못해 번호 문단을 거부한다.
// HWP 사본에서 거부되면(HWPX 문서의 그리기 개체 등이 HWP 로 바뀌며 해석하지 못한 컨트롤 데이터가 된다) HWPX 사본으로 한 번 더 본다(ADR 002)
export const DEFAULT_COPIES: MakeCopy[] = [(doc) => new HwpDocument(doc.exportHwp()), (doc) => new HwpDocument(doc.exportHwpx())];

const COPY_MISMATCH = '문서 사본이 원본과 달라 옮길 수 없습니다';

/** 사본이 원본과 같은 문단 번호를 쓸 수 있는지: 구역 문단 수와 옮길 문단 글자가 같아야 한다 */
function copyMatches(doc: HwpDocument, copy: HwpDocument, section: number, start: number, end: number): boolean {
  if (copy.getSectionCount() !== doc.getSectionCount()) return false;
  if (copy.getParagraphCount(section) !== doc.getParagraphCount(section)) return false;
  for (let p = start; p < end; p += 1) {
    if (paragraphTextOf(copy, section, p) !== paragraphTextOf(doc, section, p)) return false;
  }
  return true;
}

const paragraphTextOf = (doc: HwpDocument, section: number, paragraph: number) =>
  doc.getTextRange(section, paragraph, 0, doc.getParagraphLength(section, paragraph));

/**
 * 같은 구역 안 이어진 문단 [start, end) 를 before 문단 앞으로 옮긴다(before 는 1..문단 수, 문단 수면 맨 끝).
 * 절차(rhwp-code-analysis 5-3): 사본(copies 순서대로) → 사본이 원본과 같은지 확인 → dryRun → 실행 → 원본 지우기(인덱스 보정)
 * → 문단 모양 되돌리기. 거부되면(사본을 못 만들거나 원본과 다르거나 rhwp 가 거부) 아무것도 바꾸지 않고 거부된 문단과 이유를 돌려준다.
 * 실행 중 예외는 그대로 던진다 — 되돌리기는 부르는 쪽 스냅샷(EditHistory.apply)이 맡는다.
 */
export function moveParagraphs(
  doc: HwpDocument,
  section: number,
  start: number,
  end: number,
  before: number,
  copies: MakeCopy[] = DEFAULT_COPIES,
): MoveResult {
  const count = doc.getParagraphCount(section);
  if (!(0 <= start && start < end && end <= count && 0 <= before && before <= count)) {
    throw new Error(`옮길 문단 범위가 맞지 않습니다(start ${start}, end ${end}, before ${before}, 문단 수 ${count}).`);
  }
  if (start <= before && before <= end) throw new Error('기준 문단이 옮길 문단 안이나 바로 옆에 있습니다.');
  // 구역 첫 문단 앞에 넣으면 구역·단 정의가 둘째 문단에 남는다(rhwp 는 열지만 한글 파일 구조와 다르다, ADR 002)
  if (before === 0) throw new Error('구역 첫 문단 앞으로는 옮길 수 없습니다. 첫 문단 뒤로 옮기세요.');
  const size = end - start;
  let rejected: MoveRejection[] = [];
  const reject = (found: MoveRejection[]) => {
    // 모두 거부되면 거부가 적은 쪽, 같으면 나중 사본 쪽 이유(HWPX 사본은 책갈피 등 컨트롤 이름이 남는다)
    if (rejected.length === 0 || found.length <= rejected.length) rejected = found;
  };
  for (const makeCopy of copies) {
    let source: HwpDocument;
    try {
      source = makeCopy(doc);
    } catch (error) {
      reject([{ paragraph: start, reason: `문서 사본을 만들지 못했습니다: ${errorMessage(error)}` }]);
      continue;
    }
    try {
      // 원본의 문단 번호를 사본에 그대로 쓰므로, 왕복에서 문단이 달라졌으면 엉뚱한 문단을 들여오고 원본을 지운다
      if (!copyMatches(doc, source, section, start, end)) {
        reject([{ paragraph: start, reason: COPY_MISMATCH }]);
        continue;
      }
      const found = dryRunRejections(doc, source, section, start, end, before);
      if (found.length > 0) {
        reject(found);
        continue;
      }
      // 되돌릴 문단 모양 번호는 원본 문서의 것이다(사본은 왕복하며 모양 표 번호가 다를 수 있다)
      const shapes = Array.from({ length: size }, (_, i) => paraShapeIdOf(doc, section, start + i));
      doc.importParagraphBlock(source, importRequest(section, start, end, before, false));
      const originalStart = before <= start ? start + size : start;
      for (let p = originalStart + size - 1; p >= originalStart; p -= 1) doc.deleteParagraph(section, p);
      const movedStart = before <= start ? before : before - size;
      shapes.forEach((shape, i) => {
        if (paraShapeIdOf(doc, section, movedStart + i) !== shape) doc.setParaShapeId(section, movedStart + i, shape);
      });
      return { ok: true, moved: { start: movedStart, end: movedStart + size } };
    } finally {
      source.free();
    }
  }
  return { ok: false, rejected };
}

function dryRunRejections(
  doc: HwpDocument,
  source: HwpDocument,
  section: number,
  start: number,
  end: number,
  before: number,
): MoveRejection[] {
  try {
    doc.importParagraphBlock(source, importRequest(section, start, end, before, true));
    return [];
  } catch {
    // 범위 전체 dryRun 은 첫 거부만 알려준다. 문단마다 다시 물어 모두 모은다
    const rejected: MoveRejection[] = [];
    for (let p = start; p < end; p += 1) {
      try {
        doc.importParagraphBlock(source, importRequest(section, p, p + 1, before, true));
      } catch (error) {
        rejected.push({ paragraph: p, reason: moveRejectReason(errorMessage(error)) });
      }
    }
    // 문단 하나씩은 되는데 묶음이 안 되면(문단 경계를 넘는 누름틀 등) 범위 첫 문단에 이유를 붙인다
    if (rejected.length === 0) {
      try {
        doc.importParagraphBlock(source, importRequest(section, start, end, before, true));
      } catch (error) {
        rejected.push({ paragraph: start, reason: moveRejectReason(errorMessage(error)) });
      }
    }
    return rejected;
  }
}
