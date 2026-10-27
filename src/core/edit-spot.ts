// 뷰어에서 고칠 자리(SPEC-006 글자 고치기): 쪽 위 한 점(더블클릭·마우스 올림) → rhwp hitTest → 블록·칸·누름틀과 글자 위치.
// 입력칸 글자는 앞뒤 같은 글자를 잘라 바뀐 범위만 replace_text 사람 편집(블록 위치 대상)으로 만든다(chars.ts changedRange).
// blockAtHit(점 → 본문 블록)은 끌어 옮기기·오른쪽 클릭(#60)도 쓴다.
import type { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import { anchorsOf, blockIndexByAnchor, tableControlIndex, type BlockAnchor } from './block-ids.ts';
import type { Block, ParagraphBlock, TableBlock } from './block-schema.ts';
import { changedRange, charLength } from './chars.ts';
import { crossesField, type TextPlace } from './field-spans.ts';
import type { SelectionRect } from './highlight-rects.ts';
import { blockBoxes, tableCellBoxes } from './highlight-targets.ts';
import { parseJson } from './json.ts';
import { relocate, TEXT_PART, type ParagraphChanges } from './paragraph-changes.ts';
import type { UserEdit } from '../shared/protocol.ts';

export const BLOCK_CHANGED_WHILE_EDITING = 'Claude 가 이 문단을 바꿔서 적용하지 못했습니다. 다시 고쳐 주세요.';
export const CROSSES_FIELD_IN_VIEWER = '누름틀 값과 그 바깥 글자를 한 번에 고칠 수 없습니다. 누름틀 값은 값 위를 더블클릭해 따로 고치세요.';

/** 점이 블록 사각형 밖이어도 이만큼(쪽 px)은 그 블록으로 본다 — 바뀐 블록 테두리(--edit-mark-offset)만큼 */
const HIT_SLOP = 2;

const cellStepSchema = z.object({ controlIndex: z.number(), cellIndex: z.number(), cellParaIndex: z.number() });
/** rhwp hitTest 결과. 표 칸이면 parentParaIndex(표를 품은 본문 문단)·칸 경로가 붙는다 */
const hitSchema = z.object({
  sectionIndex: z.number(),
  paragraphIndex: z.number(),
  charOffset: z.number(),
  parentParaIndex: z.number().optional(),
  controlIndex: z.number().optional(),
  cellIndex: z.number().optional(),
  cellParaIndex: z.number().optional(),
  cellPath: z.array(cellStepSchema).optional(),
  cursorRect: z.object({ pageIndex: z.number(), x: z.number(), y: z.number(), height: z.number() }),
});
export type Hit = z.infer<typeof hitSchema>;

const pageColumnsSchema = z.object({ columns: z.array(z.object({ x: z.number(), width: z.number() })) });

export interface Point {
  x: number;
  y: number;
}

/** 쪽(0부터) 위 점의 hitTest. rhwp 는 블록 밖 빈 곳에도 가까운 문단을 준다 — 블록 안인지는 부르는 쪽이 사각형으로 본다 */
export function hitTestAt(doc: HwpDocument, pageIndex: number, { x, y }: Point): Hit | undefined {
  const hit = hitSchema.safeParse(JSON.parse(doc.hitTest(pageIndex, x, y)));
  return hit.success ? hit.data : undefined;
}

/** 점이 놓인 본문 블록(문단·표). 표 칸이면 칸, offset 은 블록(칸) text 안 글자 위치 */
export interface BlockHit {
  index: number;
  anchor: BlockAnchor;
  block: ParagraphBlock | TableBlock;
  cell?: { index: number; row: number; col: number };
  offset: number;
}

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

/**
 * hitTest 결과 → 본문 블록. 블록이 아닌 문단(처음 열 때 빈 문단), 표 안 표·글상자 칸은 undefined.
 * 칸 안 글자 위치는 칸 text(칸 안 문단을 \n 으로 이음) 안 위치로 바꾼다
 */
export function blockAtHit(hit: Hit, blocks: Block[]): BlockHit | undefined {
  const anchors = anchorsOf(blocks);
  const at = (index: number) => {
    const anchor = anchors[index];
    const block = blocks[index];
    return anchor === undefined || block === undefined || block.kind === 'field' ? undefined : { anchor, block };
  };
  const { sectionIndex: section, parentParaIndex, cellPath } = hit;
  if (parentParaIndex === undefined) {
    const index = blocks.findIndex((block) => block.kind === 'paragraph' && block.section === section && block.paragraph === hit.paragraphIndex);
    const found = at(index);
    if (found?.block.kind !== 'paragraph') return undefined;
    return { index, ...found, offset: clamp(hit.charOffset, charLength(found.block.text)) };
  }
  const [step, nested] = cellPath ?? [];
  if (step === undefined || nested !== undefined) return undefined;
  const index = blocks.findIndex(
    (block) => block.kind === 'table' && block.section === section && block.paragraph === parentParaIndex && block.controlIndex === step.controlIndex,
  );
  const found = at(index);
  if (found?.block.kind !== 'table') return undefined;
  const cell = found.block.cells[step.cellIndex];
  if (cell === undefined) return undefined;
  const paragraphs = cell.text.split('\n');
  const before = paragraphs.slice(0, step.cellParaIndex).reduce((sum, text) => sum + charLength(text) + 1, 0);
  const offset = before + clamp(hit.charOffset, charLength(paragraphs[step.cellParaIndex] ?? ''));
  return { index, ...found, cell: { index: step.cellIndex, row: cell.row, col: cell.col }, offset };
}

/** 고칠 자리: 블록(문단·표 칸·누름틀), 입력칸 처음 글자(블록·칸 글자 전체, 누름틀은 값), 커서 글자 위치 */
export interface EditSpot {
  anchor: BlockAnchor;
  cell?: { row: number; col: number };
  text: string;
  caret: number;
}

const contains = (box: SelectionRect, pageIndex: number, { x, y }: Point) =>
  box.pageIndex === pageIndex &&
  box.x - HIT_SLOP <= x &&
  x <= box.x + box.width + HIT_SLOP &&
  box.y - HIT_SLOP <= y &&
  y <= box.y + box.height + HIT_SLOP;

/** 블록 하나의 사각형(바뀐 블록 표시와 같다). 자리를 못 찾으면(빈 문단) 빈 배열 */
const boxesOf = (doc: HwpDocument, blocks: Block[], anchor: BlockAnchor) => blockBoxes(doc, blocks, [anchor]).boxes;

/** 빈 문단은 글자 사각형이 없어 커서 줄의 단(column) 폭을 자리로 쓴다 */
function emptyLineBox(doc: HwpDocument, caret: Hit['cursorRect']): SelectionRect {
  const { columns } = parseJson(pageColumnsSchema, doc.getPageInfo(caret.pageIndex));
  const column = columns.find(({ x, width }) => x <= caret.x && caret.x <= x + width) ?? columns[0] ?? { x: caret.x, width: caret.height };
  return { pageIndex: caret.pageIndex, x: column.x, y: caret.y, width: column.width, height: caret.height };
}

/** 점이 놓인 글자 블록(문단, 또는 cell 이 있으면 그 칸)의 누름틀 값 블록들(블록 순서와 위치) */
function fieldsIn(blocks: Block[], place: TextPlace): Array<{ index: number; anchor: BlockAnchor; value: string; start: number; end: number }> {
  const anchors = anchorsOf(blocks);
  return blocks.flatMap((block, index) => {
    const anchor = anchors[index];
    if (block.kind !== 'field' || block.span === undefined || anchor === undefined) return [];
    if (block.section !== place.section || block.paragraph !== place.paragraph) return [];
    const { cell } = block.span;
    const sameCell =
      cell === undefined || place.cell === undefined
        ? cell === place.cell
        : cell.controlIndex === place.cell.controlIndex && cell.row === place.cell.row && cell.col === place.cell.col;
    return sameCell ? [{ index, anchor, value: block.value, start: block.span.start, end: block.span.end }] : [];
  });
}

const placeOf = ({ block, cell }: BlockHit): TextPlace =>
  cell === undefined || block.kind !== 'table'
    ? { section: block.section, paragraph: block.paragraph }
    : { section: block.section, paragraph: block.paragraph, cell: { controlIndex: block.controlIndex, row: cell.row, col: cell.col } };

/**
 * 쪽 위 점 → 고칠 자리와 그 테두리 사각형(마우스 올림). 누름틀 값(빈 누름틀은 안내문) 위면 누름틀, 아니면 문단·표 칸.
 * 블록 사각형 밖(빈 곳·글상자·머리말 등)이거나 고칠 수 없는 자리면 undefined
 */
export function editSpotAt(doc: HwpDocument, blocks: Block[], pageIndex: number, point: Point): { spot: EditSpot; box: SelectionRect } | undefined {
  const hit = hitTestAt(doc, pageIndex, point);
  const base = hit === undefined ? undefined : blockAtHit(hit, blocks);
  if (hit === undefined || base === undefined) return undefined;
  for (const field of fieldsIn(blocks, placeOf(base))) {
    const box = boxesOf(doc, blocks, field.anchor).find((candidate) => contains(candidate, pageIndex, point));
    if (box !== undefined) return { spot: { anchor: field.anchor, text: field.value, caret: clamp(base.offset - field.start, charLength(field.value)) }, box };
  }
  const { block, cell, anchor, offset } = base;
  if (block.kind === 'table') {
    if (cell === undefined) return undefined;
    const box = tableCellBoxes(doc, block).find((candidate) => candidate.cellIndex === cell.index && contains(candidate, pageIndex, point));
    if (box === undefined) return undefined;
    const { x, y, width, height } = box;
    return {
      spot: { anchor, cell: { row: cell.row, col: cell.col }, text: block.cells[cell.index]?.text ?? '', caret: offset },
      box: { pageIndex, x, y, width, height },
    };
  }
  const boxes = block.text.length === 0 ? [emptyLineBox(doc, hit.cursorRect)] : boxesOf(doc, blocks, anchor);
  const box = boxes.find((candidate) => contains(candidate, pageIndex, point));
  return box === undefined ? undefined : { spot: { anchor, text: block.text, caret: offset }, box };
}

/** 지금 블록 목록에서 자리의 글자(문단 글자·칸 글자·누름틀 값). 블록·칸이 없으면 undefined */
function spotText(blocks: Block[], spot: EditSpot): string | undefined {
  const index = blockIndexByAnchor(blocks)(spot.anchor);
  const block = index === undefined ? undefined : blocks[index];
  switch (block?.kind) {
    case 'paragraph':
      return spot.cell === undefined ? block.text : undefined;
    case 'table':
      return block.cells.find((cell) => cell.row === spot.cell?.row && cell.col === spot.cell.col)?.text;
    case 'field':
      return block.value;
    case undefined:
      return undefined;
  }
}

/**
 * 입력칸이 열린 동안 적용된 편집(Claude 편집)을 따라 자리의 블록 위치를 옮긴다. 그 블록 문단이 지워졌으면 undefined.
 * changes 가 없는 편집(글자 바꾸기 등)은 문단 위치를 바꾸지 않는다
 */
export function followEdit(spot: EditSpot, changes: ParagraphChanges | undefined): EditSpot | undefined {
  if (changes === undefined) return spot;
  const moved = relocate(changes)(spot.anchor);
  return moved === undefined ? undefined : { ...spot, anchor: { ...spot.anchor, section: moved.section, paragraph: moved.paragraph } };
}

/**
 * 입력칸 글자 → 사람 편집(replace_text, 바뀐 범위만). 입력칸을 열 때 글자와 같으면(고친 것이 없으면) undefined.
 * 고쳤는데 그사이 그 블록(칸·누름틀) 글자가 바뀌었으면(입력칸이 열린 동안 Claude 편집, AC-8) 던진다.
 * 문단·칸 입력칸에서 바뀐 범위가 누름틀 값 안에만 있으면 그 누름틀 값 편집으로 보내고, 값과 바깥에 걸치면 던진다
 * (서버 replace_text 는 걸친 문단 범위를 거부한다 — #69)
 */
export function replaceEditAt(blocks: Block[], spot: EditSpot, after: string): UserEdit | undefined {
  const range = changedRange(spot.text, after);
  if (range === undefined) return undefined;
  if (spotText(blocks, spot) !== spot.text) throw new Error(BLOCK_CHANGED_WHILE_EDITING);
  const { start, end, text } = range;
  const cell = spot.cell === undefined ? {} : { cell: spot.cell };
  const own = { kind: 'replace_text', target: { anchor: spot.anchor, ...cell, start, end }, text } as const;
  // 누름틀 입력칸은 값만 고친다. 문단·칸 입력칸은 그 안 누름틀 값과 걸치는지 본다
  const controlIndex = tableControlIndex(spot.anchor);
  if (spot.anchor.part !== TEXT_PART && controlIndex === undefined) return own;
  const { section, paragraph } = spot.anchor;
  const place: TextPlace =
    spot.cell === undefined || controlIndex === undefined ? { section, paragraph } : { section, paragraph, cell: { controlIndex, ...spot.cell } };
  for (const field of fieldsIn(blocks, place)) {
    if (!crossesField(range, field)) continue;
    if (field.start <= start && end <= field.end) {
      return { kind: 'replace_text', target: { anchor: field.anchor, start: start - field.start, end: end - field.start }, text };
    }
    throw new Error(CROSSES_FIELD_IN_VIEWER);
  }
  return own;
}
