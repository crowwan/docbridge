// 하이라이트 대상(블록 위치 + 칸 + 글자 범위)을 쪽 위 사각형으로 바꾼다. 뷰어와 테스트 뷰어가 같이 쓴다.
// 글자 위치는 read_blocks 가 주는 블록 text(표는 칸 안 문단을 \n 으로 이은 칸 text) 안 유니코드 글자 위치(core/chars.ts)라
// rhwp 글자 위치와 단위가 같다.
import type { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import { parseJson } from './json.ts';
import { blockIndexByAnchor, fieldOrdinal, type BlockAnchor } from './block-ids.ts';
import type { Block, FieldBlock, TableBlock } from './block-schema.ts';
import { cellParagraphTexts } from './blocks.ts';
import { charLength } from './chars.ts';
import { spanIn, targetLabel } from './text-targets.ts';
import { selectionRects, type CellLocation, type SelectionRect } from './highlight-rects.ts';

/** 하이라이트 대상 (shared/protocol.ts 의 TextTarget + 서버가 붙인 블록 위치) */
export interface HighlightTarget {
  id: string;
  anchor: BlockAnchor;
  cell?: { row: number; col: number } | undefined;
  start?: number | undefined;
  end?: number | undefined;
}

export interface HighlightPlan {
  /** 대상마다 사각형(대상 순서) */
  rects: SelectionRect[][];
  /** 하이라이트가 있는 모든 쪽(1부터, 중복 없이 오름차순) */
  pages: number[];
  /** 그리긴 했지만 정확하지 않을 수 있는 대상 안내 */
  warnings: string[];
}

const cellBoxesSchema = z.array(
  z.object({ cellIdx: z.number(), pageIndex: z.number(), x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
);
const caretSchema = z.object({ pageIndex: z.number(), x: z.number(), y: z.number(), height: z.number() });
const pathStepSchema = z.object({
  type: z.string().optional(),
  controlIndex: z.number(),
  cellIndex: z.number(),
  paraIndex: z.number(),
});
const fieldListSchema = z.array(
  z.object({
    fieldType: z.string(),
    guide: z.string(),
    location: z.object({ sectionIndex: z.number(), paraIndex: z.number(), path: z.array(pathStepSchema).optional() }),
    startCharIdx: z.number(),
  }),
);
export type FieldEntry = z.infer<typeof fieldListSchema>[number];
const runSchema = z.object({ text: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export const layoutSchema = z.object({ runs: z.array(runSchema) });
export type LayoutRun = z.infer<typeof runSchema>;
export interface Caret {
  pageIndex: number;
  x: number;
  y: number;
  height: number;
}

/** 표 칸마다 칸 사각형(쪽에 걸친 칸은 쪽마다 하나씩). 빈 칸 하이라이트·마우스 올림 테두리(SPEC-006)가 쓴다 */
export function tableCellBoxes(doc: HwpDocument, block: TableBlock): Array<SelectionRect & { cellIndex: number }> {
  return parseJson(cellBoxesSchema, doc.getTableCellBboxes(block.section, block.paragraph, block.controlIndex)).map(
    ({ cellIdx, pageIndex, x, y, w, h }) => ({ cellIndex: cellIdx, pageIndex, x, y, width: w, height: h }),
  );
}

/** 하이라이트는 칠할 글자가 있어야 한다(빈 범위 안 됨) */
const HIGHLIGHT_SPAN = { allowEmpty: false };
const isWhole = (target: HighlightTarget) => target.start === undefined && target.end === undefined;

/** 쪽마다 사각형들을 감싸는 사각형 하나로 합친다 */
function unionByPage(rects: SelectionRect[]): SelectionRect[] {
  const byPage = new Map<number, SelectionRect>();
  for (const rect of rects) {
    const seen = byPage.get(rect.pageIndex);
    if (seen === undefined) {
      byPage.set(rect.pageIndex, rect);
      continue;
    }
    const left = Math.min(seen.x, rect.x);
    const top = Math.min(seen.y, rect.y);
    const right = Math.max(seen.x + seen.width, rect.x + rect.width);
    const bottom = Math.max(seen.y + seen.height, rect.y + rect.height);
    byPage.set(rect.pageIndex, { pageIndex: rect.pageIndex, x: left, y: top, width: right - left, height: bottom - top });
  }
  return [...byPage.values()];
}

/** 칸 text(문단을 \n 으로 이음) 안 글자 위치 → 칸 문단 번호와 그 문단 안 글자 위치 */
export function cellPosition(paragraphs: string[], index: number): { paragraph: number; offset: number } {
  let rest = index;
  for (const [paragraph, text] of paragraphs.entries()) {
    const length = charLength(text);
    if (rest <= length) return { paragraph, offset: rest };
    rest -= length + 1;
  }
  const last = paragraphs.length - 1;
  return { paragraph: last, offset: charLength(paragraphs[last] ?? '') };
}

/**
 * 누름틀이 든 문단 자리: 본문이면 칸 없이, 표 칸이면 칸 위치와 칸 안 문단.
 * 표 안 표(경로 2단 이상)나 표 칸이 아닌 곳(글상자 등)에 든 누름틀은 v0.1 에서 하이라이트하지 않는다
 */
export function fieldPlace(
  id: string,
  field: FieldEntry,
  section: number,
  blocks: Block[],
): { cell?: CellLocation; paragraph: number } {
  const path = field.location.path ?? [];
  const [step] = path;
  if (step === undefined) return { paragraph: field.location.paraIndex };
  if (path.length > 1) throw new Error(`${id}: 표 안 표에 든 누름틀은 아직 하이라이트할 수 없습니다.`);
  const parentParagraph = field.location.paraIndex;
  const inBodyTable = blocks.some(
    (block) =>
      block.kind === 'table' &&
      block.section === section &&
      block.paragraph === parentParagraph &&
      block.controlIndex === step.controlIndex,
  );
  if ((step.type !== undefined && step.type !== 'cell') || !inBodyTable) {
    throw new Error(`${id}: 표 칸이 아닌 곳(글상자 등)에 든 누름틀은 아직 하이라이트할 수 없습니다.`);
  }
  return { cell: { parentParagraph, controlIndex: step.controlIndex, cellIndex: step.cellIndex }, paragraph: step.paraIndex };
}

/**
 * 값이 빈 누름틀의 안내문 자리: 캐럿 자리에서 시작해 안내문을 이루는 글자 배치(run)들.
 * 안내문이 줄바꿈 등으로 여러 run 으로 나뉘어도 이어 붙여 맞춘다. 끝까지 맞지 않으면 undefined
 */
export function guideRects(runs: LayoutRun[], guide: string, caret: Caret): SelectionRect[] | undefined {
  if (guide.length === 0) return undefined;
  const startIndex = runs.findIndex(
    (run) =>
      run.text.length > 0 &&
      guide.startsWith(run.text) &&
      Math.abs(run.x - caret.x) <= 1 &&
      run.y <= caret.y + 1 &&
      caret.y < run.y + run.h,
  );
  if (startIndex === -1) return undefined;
  const rects: SelectionRect[] = [];
  let joined = '';
  for (const run of runs.slice(startIndex)) {
    if (run.text.length === 0) continue;
    if (!guide.startsWith(joined + run.text)) return undefined;
    joined += run.text;
    rects.push({ pageIndex: caret.pageIndex, x: run.x, y: run.y, width: run.w, height: run.h });
    if (joined === guide) return rects;
  }
  return undefined;
}

/** 요청 하나 동안 문서 공용 정보(블록 위치 표·누름틀 목록·쪽 글자 배치)를 한 번씩만 읽는다 */
class HighlightContext {
  readonly warnings: string[] = [];
  private readonly indexOf: (anchor: BlockAnchor) => number | undefined;
  private fieldList: FieldEntry[] | undefined;
  private readonly layouts = new Map<number, LayoutRun[]>();
  private readonly doc: HwpDocument;
  private readonly blocks: Block[];

  constructor(doc: HwpDocument, blocks: Block[]) {
    this.doc = doc;
    this.blocks = blocks;
    this.indexOf = blockIndexByAnchor(blocks);
  }

  rects(target: HighlightTarget): SelectionRect[] {
    const index = this.indexOf(target.anchor);
    const block = index === undefined ? undefined : this.blocks[index];
    if (block === undefined) throw new Error(`${target.id}: 뷰어 문서에 이 블록이 없습니다. get_outline 을 다시 부르세요.`);
    let rects: SelectionRect[];
    switch (block.kind) {
      case 'paragraph': {
        if (target.cell !== undefined) throw new Error(`${target.id}: 표 블록이 아니라 cell 을 줄 수 없습니다.`);
        const { start, end } = spanIn(target, block.text, HIGHLIGHT_SPAN);
        rects = selectionRects(this.doc, {
          section: block.section,
          startParagraph: block.paragraph,
          startOffset: start,
          endParagraph: block.paragraph,
          endOffset: end,
        });
        break;
      }
      case 'table':
        rects = this.tableRects(block, target);
        break;
      case 'field':
        rects = this.fieldRects(block, target);
        break;
    }
    if (rects.length === 0) throw new Error(`${targetLabel(target)}: 화면에서 하이라이트할 자리를 찾지 못했습니다.`);
    return rects;
  }

  private cellBoxes(block: TableBlock): Array<SelectionRect & { cellIndex: number }> {
    return tableCellBoxes(this.doc, block);
  }

  private tableRects(block: TableBlock, target: HighlightTarget): SelectionRect[] {
    if (target.cell === undefined) {
      if (!isWhole(target)) throw new Error(`${target.id}: 표 블록에서 글자 범위를 고르려면 cell 을 함께 주세요.`);
      // 표 전체: 쪽마다 칸들을 감싸는 사각형
      return unionByPage(this.cellBoxes(block));
    }
    const { row, col } = target.cell;
    const cellIndex = block.cells.findIndex((cell) => cell.row === row && cell.col === col);
    if (cellIndex === -1) {
      throw new Error(
        `${target.id}: 표에 없는 칸입니다(row ${row}, col ${col}). 이 표는 ${block.rowCount}행 ${block.colCount}열이고, 합친 칸은 왼쪽 위 칸 좌표로 고릅니다(read_blocks 의 cells).`,
      );
    }
    const paragraphs = cellParagraphTexts(this.doc, block.section, block.paragraph, block.controlIndex, cellIndex);
    const text = paragraphs.join('\n');
    // 빈 칸 전체: 글자가 없으니 칸 자리를 칠한다
    if (charLength(text) === 0 && isWhole(target)) return this.cellBoxes(block).filter((box) => box.cellIndex === cellIndex);
    const { start, end } = spanIn(target, text, HIGHLIGHT_SPAN);
    const from = cellPosition(paragraphs, start);
    const to = cellPosition(paragraphs, end);
    return selectionRects(this.doc, {
      section: block.section,
      cell: { parentParagraph: block.paragraph, controlIndex: block.controlIndex, cellIndex },
      startParagraph: from.paragraph,
      startOffset: from.offset,
      endParagraph: to.paragraph,
      endOffset: to.offset,
    });
  }

  private fields(): FieldEntry[] {
    this.fieldList ??= parseJson(fieldListSchema, this.doc.getFieldList()).filter((f) => f.fieldType === 'clickhere');
    return this.fieldList;
  }

  private layout(pageIndex: number): LayoutRun[] {
    const cached = this.layouts.get(pageIndex);
    if (cached !== undefined) return cached;
    const runs = parseJson(layoutSchema, this.doc.getPageTextLayout(pageIndex)).runs;
    this.layouts.set(pageIndex, runs);
    return runs;
  }

  private fieldRects(block: FieldBlock, target: HighlightTarget): SelectionRect[] {
    if (target.cell !== undefined) throw new Error(`${target.id}: 표 블록이 아니라 cell 을 줄 수 없습니다.`);
    // 같은 문단의 몇 번째 누름틀인지는 서버가 보낸 위치에 있다(블록 추출이 getFieldList 순서를 따른다)
    const ordinal = fieldOrdinal(target.anchor) ?? 0;
    const field = this.fields().filter(
      (f) => f.location.sectionIndex === block.section && f.location.paraIndex === block.paragraph,
    )[ordinal];
    if (field === undefined) throw new Error(`${target.id}: 뷰어 문서에서 이 누름틀을 찾지 못했습니다. get_outline 을 다시 부르세요.`);
    const { cell, paragraph } = fieldPlace(target.id, field, block.section, this.blocks);

    if (charLength(block.value) === 0 && isWhole(target)) return this.emptyFieldRects(target, block, field, cell, paragraph);
    const { start, end } = spanIn(target, block.value, HIGHLIGHT_SPAN);
    return selectionRects(this.doc, {
      section: block.section,
      ...(cell === undefined ? {} : { cell }),
      startParagraph: paragraph,
      startOffset: field.startCharIdx + start,
      endParagraph: paragraph,
      endOffset: field.startCharIdx + end,
    });
  }

  // 값이 빈 누름틀은 글자 대신 안내문(빨간 기울임)이 글자 배치로만 그려진다. 누름틀 자리 캐럿에서 시작하는 안내문을 칠한다.
  private emptyFieldRects(
    target: HighlightTarget,
    block: FieldBlock,
    field: FieldEntry,
    cell: CellLocation | undefined,
    paragraph: number,
  ): SelectionRect[] {
    const caret = parseJson(
      caretSchema,
      cell === undefined
        ? this.doc.getCursorRect(block.section, paragraph, field.startCharIdx)
        : this.doc.getCursorRectInCell(block.section, cell.parentParagraph, cell.controlIndex, cell.cellIndex, paragraph, field.startCharIdx),
    );
    const guide = guideRects(this.layout(caret.pageIndex), field.guide, caret);
    if (guide !== undefined) return guide;
    this.warnings.push(`${target.id}: 빈 누름틀의 안내문 자리를 찾지 못해 누름틀 자리에 글자 하나 크기로 표시했습니다.`);
    return [{ pageIndex: caret.pageIndex, x: caret.x, y: caret.y, width: caret.height, height: caret.height }];
  }
}

/**
 * 요청 하나의 대상들을 사각형으로 바꾼다. 대상 하나라도 블록에 맞지 않으면 무엇이 틀렸는지 담아 던진다(아무것도 그리지 않게).
 * 문서 공용 정보는 요청마다 한 번만 읽는다
 */
export function highlightTargets(doc: HwpDocument, blocks: Block[], targets: HighlightTarget[]): HighlightPlan {
  const context = new HighlightContext(doc, blocks);
  const rects = targets.map((target) => context.rects(target));
  const pages = [...new Set(rects.flat().map((rect) => rect.pageIndex + 1))].sort((a, b) => a - b);
  return { rects, pages, warnings: context.warnings };
}

export interface BlockBoxes {
  /** 쪽마다 블록을 감싸는 사각형. 다른 사각형 안에 든 것(문단 안 누름틀 값 등)은 뺀다 */
  boxes: SelectionRect[];
  /** 화면에서 자리를 찾지 못해 표시하지 못한 블록(글자를 모두 지운 빈 문단 등) */
  unmarked: BlockAnchor[];
}

const contains = (outer: SelectionRect, inner: SelectionRect) =>
  outer.pageIndex === inner.pageIndex &&
  outer.x <= inner.x &&
  outer.y <= inner.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

/**
 * 바뀐 블록 표시(SPEC-002): 블록마다 쪽별로 블록 전체(문단 줄·표·누름틀 값)를 감싸는 사각형.
 * 자리를 못 찾은 블록은 표시하지 않고 unmarked 로 알린다(편집은 이미 끝났다)
 */
export function blockBoxes(doc: HwpDocument, blocks: Block[], anchors: BlockAnchor[]): BlockBoxes {
  const context = new HighlightContext(doc, blocks);
  const unmarked: BlockAnchor[] = [];
  const all = anchors.flatMap((anchor) => {
    try {
      return unionByPage(context.rects({ id: '', anchor }));
    } catch {
      // 이유(빈 문단·글상자 누름틀 등)는 결과에 블록 id 로 남긴다. 문구는 서버가 붙인다
      unmarked.push(anchor);
      return [];
    }
  });
  const boxes = all.filter((box, i) => !all.some((other, j) => j !== i && contains(other, box) && !(contains(box, other) && j > i)));
  return { boxes, unmarked };
}
