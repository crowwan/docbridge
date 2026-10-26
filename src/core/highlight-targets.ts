// 하이라이트 대상(블록 id + 칸 + 글자 범위)을 쪽 위 사각형으로 바꾼다.
// 글자 위치는 read_blocks 가 주는 블록 text(표는 칸 안 문단을 \n 으로 이은 칸 text) 기준의 JS 문자열 위치(UTF-16)다.
// rhwp 의 글자 위치는 유니코드 글자(code point) 단위라서, 한글은 같지만 이모지 같은 BMP 밖 글자 뒤에서는 달라진다.
// 그래서 rhwp 에 넘기기 전에 글자 단위로 바꾼다.
import type { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import type { Block, FieldBlock, TableBlock } from './block-schema.ts';
import { selectionRects, type CellLocation, type SelectionRect } from './highlight-rects.ts';

/** 하이라이트 대상에서 블록을 찾은 뒤 남는 것 (shared/protocol.ts 의 TextTarget 과 같은 모양) */
export interface TargetSpan {
  id: string;
  cell?: { row: number; col: number } | undefined;
  start?: number | undefined;
  end?: number | undefined;
}

const cellBoxesSchema = z.array(
  z.object({ cellIdx: z.number(), pageIndex: z.number(), x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
);
const caretSchema = z.object({ pageIndex: z.number(), x: z.number(), y: z.number(), height: z.number() });
const fieldListSchema = z.array(
  z.object({
    fieldType: z.string(),
    guide: z.string(),
    location: z.object({
      sectionIndex: z.number(),
      paraIndex: z.number(),
      path: z.array(z.object({ controlIndex: z.number(), cellIndex: z.number(), paraIndex: z.number() })).optional(),
    }),
    startCharIdx: z.number(),
  }),
);
const layoutSchema = z.object({
  runs: z.array(z.object({ text: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number() })),
});

const parse = <T>(schema: z.ZodType<T>, json: string): T => schema.parse(JSON.parse(json));

/** JS 문자열 위치(UTF-16) → rhwp 글자 위치(code point) */
const charIndex = (text: string, utf16Index: number) => [...text.slice(0, utf16Index)].length;

/** 대상의 start·end 를 검사해 [시작, 끝) 으로. 둘 다 없으면 전체 */
function spanIn(target: TargetSpan, text: string, where: string): { start: number; end: number } {
  const start = target.start ?? 0;
  const end = target.end ?? text.length;
  if (start >= end || end > text.length) {
    throw new Error(
      `${where}: 글자 범위가 맞지 않습니다(start ${start}, end ${end}, 글자 수 ${text.length}). 0 ≤ start < end ≤ 글자 수로 주세요.`,
    );
  }
  return { start, end };
}

const whereOf = (target: TargetSpan) =>
  target.cell === undefined ? target.id : `${target.id} 칸(${target.cell.row},${target.cell.col})`;

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

function cellBoxes(doc: HwpDocument, block: TableBlock): Array<SelectionRect & { cellIndex: number }> {
  return parse(cellBoxesSchema, doc.getTableCellBboxes(block.section, block.paragraph, block.controlIndex)).map(
    ({ cellIdx, pageIndex, x, y, w, h }) => ({ cellIndex: cellIdx, pageIndex, x, y, width: w, height: h }),
  );
}

function tableRects(doc: HwpDocument, block: TableBlock, target: TargetSpan): SelectionRect[] {
  if (target.cell === undefined) {
    if (target.start !== undefined || target.end !== undefined) {
      throw new Error(`${target.id}: 표 블록에서 글자 범위를 고르려면 cell 을 함께 주세요.`);
    }
    // 표 전체: 쪽마다 칸들을 감싸는 사각형
    return unionByPage(cellBoxes(doc, block));
  }
  const { row, col } = target.cell;
  const cellIndex = block.cells.findIndex((cell) => cell.row === row && cell.col === col);
  if (cellIndex === -1) {
    throw new Error(
      `${target.id}: 표에 없는 칸입니다(row ${row}, col ${col}). 이 표는 ${block.rowCount}행 ${block.colCount}열이고, 합친 칸은 왼쪽 위 칸 좌표로 고릅니다(read_blocks 의 cells).`,
    );
  }
  const location: CellLocation = { parentParagraph: block.paragraph, controlIndex: block.controlIndex, cellIndex };
  const paragraphs = cellParagraphTexts(doc, block, cellIndex);
  const text = paragraphs.join('\n');
  if (text.length === 0 && target.start === undefined && target.end === undefined) {
    // 빈 칸 전체: 글자가 없으니 칸 자리를 칠한다
    return cellBoxes(doc, block).filter((box) => box.cellIndex === cellIndex);
  }
  const { start, end } = spanIn(target, text, whereOf(target));
  const from = cellPosition(paragraphs, start);
  const to = cellPosition(paragraphs, end);
  return selectionRects(doc, {
    section: block.section,
    cell: location,
    startParagraph: from.paragraph,
    startOffset: from.offset,
    endParagraph: to.paragraph,
    endOffset: to.offset,
  });
}

function cellParagraphTexts(doc: HwpDocument, block: TableBlock, cellIndex: number): string[] {
  const { section, paragraph, controlIndex } = block;
  const count = doc.getCellParagraphCount(section, paragraph, controlIndex, cellIndex);
  return Array.from({ length: count }, (_, p) =>
    doc.getTextInCell(section, paragraph, controlIndex, cellIndex, p, 0, doc.getCellParagraphLength(section, paragraph, controlIndex, cellIndex, p)),
  );
}

/** 칸 text(문단을 \n 으로 이음) 안 위치 → 칸 문단 번호와 그 문단 안 rhwp 글자 위치 */
export function cellPosition(paragraphs: string[], utf16Index: number): { paragraph: number; offset: number } {
  let rest = utf16Index;
  for (const [paragraph, text] of paragraphs.entries()) {
    if (rest <= text.length) return { paragraph, offset: charIndex(text, rest) };
    rest -= text.length + 1;
  }
  const last = paragraphs.length - 1;
  return { paragraph: last, offset: [...(paragraphs[last] ?? '')].length };
}

function fieldRects(doc: HwpDocument, blocks: Block[], blockIndex: number, block: FieldBlock, target: TargetSpan): SelectionRect[] {
  if (target.cell !== undefined) throw new Error(`${target.id}: 표 블록이 아니라 cell 을 줄 수 없습니다.`);
  // 같은 문단의 몇 번째 누름틀인지(블록 추출이 getFieldList 순서를 따른다)
  const ordinal = blocks
    .slice(0, blockIndex)
    .filter((b) => b.kind === 'field' && b.section === block.section && b.paragraph === block.paragraph).length;
  const field = parse(fieldListSchema, doc.getFieldList()).filter(
    (f) => f.fieldType === 'clickhere' && f.location.sectionIndex === block.section && f.location.paraIndex === block.paragraph,
  )[ordinal];
  if (field === undefined) throw new Error(`${target.id}: 뷰어 문서에서 이 누름틀을 찾지 못했습니다. get_outline 을 다시 부르세요.`);
  const path = field.location.path ?? [];
  const [step] = path;
  if (path.length > 1) throw new Error(`${target.id}: 표 안 표에 든 누름틀은 아직 하이라이트할 수 없습니다.`);
  const cell: CellLocation | undefined =
    step === undefined ? undefined : { parentParagraph: block.paragraph, controlIndex: step.controlIndex, cellIndex: step.cellIndex };
  const paragraph = step === undefined ? block.paragraph : step.paraIndex;

  if (block.value.length === 0 && target.start === undefined && target.end === undefined) {
    return emptyFieldRects(doc, block, field.guide, field.startCharIdx, cell, paragraph);
  }
  const { start, end } = spanIn(target, block.value, target.id);
  return selectionRects(doc, {
    section: block.section,
    ...(cell === undefined ? {} : { cell }),
    startParagraph: paragraph,
    startOffset: field.startCharIdx + charIndex(block.value, start),
    endParagraph: paragraph,
    endOffset: field.startCharIdx + charIndex(block.value, end),
  });
}

// 값이 빈 누름틀은 글자 대신 안내문(빨간 기울임)이 그려진다. 누름틀 자리 캐럿에서 시작하는 안내문 글자 배치를 칠한다.
function emptyFieldRects(
  doc: HwpDocument,
  block: FieldBlock,
  guide: string,
  offset: number,
  cell: CellLocation | undefined,
  paragraph: number,
): SelectionRect[] {
  const caret = parse(
    caretSchema,
    cell === undefined
      ? doc.getCursorRect(block.section, paragraph, offset)
      : doc.getCursorRectInCell(block.section, cell.parentParagraph, cell.controlIndex, cell.cellIndex, paragraph, offset),
  );
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  const run = parse(layoutSchema, doc.getPageTextLayout(caret.pageIndex)).runs.find(
    (r) => r.text === guide && guide.length > 0 && near(r.x, caret.x) && r.y <= caret.y + 1 && caret.y < r.y + r.h,
  );
  if (run !== undefined) return [{ pageIndex: caret.pageIndex, x: run.x, y: run.y, width: run.w, height: run.h }];
  // 안내문도 없으면 누름틀 자리에 글자 하나 폭만큼
  return [{ pageIndex: caret.pageIndex, x: caret.x, y: caret.y, width: caret.height, height: caret.height }];
}

/** 블록(blocks[blockIndex]) 안 대상의 사각형. 대상이 블록에 맞지 않으면 무엇이 틀렸는지 담아 던진다 */
export function targetRects(doc: HwpDocument, blocks: Block[], blockIndex: number, target: TargetSpan): SelectionRect[] {
  const block = blocks[blockIndex];
  if (block === undefined) throw new Error(`${target.id}: 뷰어 문서에 이 블록이 없습니다. get_outline 을 다시 부르세요.`);
  let rects: SelectionRect[];
  switch (block.kind) {
    case 'paragraph': {
      if (target.cell !== undefined) throw new Error(`${target.id}: 표 블록이 아니라 cell 을 줄 수 없습니다.`);
      const { start, end } = spanIn(target, block.text, target.id);
      rects = selectionRects(doc, {
        section: block.section,
        startParagraph: block.paragraph,
        startOffset: charIndex(block.text, start),
        endParagraph: block.paragraph,
        endOffset: charIndex(block.text, end),
      });
      break;
    }
    case 'table':
      rects = tableRects(doc, block, target);
      break;
    case 'field':
      rects = fieldRects(doc, blocks, blockIndex, block, target);
      break;
  }
  if (rects.length === 0) throw new Error(`${whereOf(target)}: 화면에서 하이라이트할 자리를 찾지 못했습니다.`);
  return rects;
}
