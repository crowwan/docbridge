import type { HwpDocument } from '@rhwp/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Block } from '../src/core/block-schema.ts';
import { extractBlocks } from '../src/core/blocks.ts';
import { selectionRects } from '../src/core/highlight-rects.ts';
import { cellPosition, targetRects, type TargetSpan } from '../src/core/highlight-targets.ts';
import { createBlankDocument } from '../src/core/rhwp-node.ts';
import { openFixture } from './fixtures.ts';

function blockIndex(blocks: Block[], match: (block: Block) => boolean): number {
  const index = blocks.findIndex(match);
  if (index === -1) throw new Error('블록이 없다');
  return index;
}

function rectsOf(doc: HwpDocument, match: (block: Block) => boolean, target: Omit<TargetSpan, 'id'>) {
  const blocks = extractBlocks(doc);
  return targetRects(doc, blocks, blockIndex(blocks, match), { id: 'b1', ...target });
}

const paragraphAt = (paragraph: number) => (block: Block) => block.kind === 'paragraph' && block.paragraph === paragraph;
const isTable = (block: Block) => block.kind === 'table';
const isField = (block: Block) => block.kind === 'field';

// 앞 문단 + 2×2 표. 칸 1 에 "값: " 뒤 누름틀(값 "채운 값"), 칸 2 에 세 문단(가운데는 빈 문단)
function tableDocument(): HwpDocument {
  const doc = createBlankDocument();
  doc.insertText(0, 0, 0, '앞 문단');
  doc.createTable(0, 0, 4, 2, 2);
  doc.insertTextInCell(0, 1, 0, 1, 0, 0, '값: ');
  doc.insertClickHereFieldInCell(0, 1, 0, 1, 0, 3, false, '안내', '', '칸필드', true);
  const fieldId = z.array(z.object({ fieldId: z.number() })).parse(JSON.parse(doc.getFieldList()))[0]?.fieldId ?? 0;
  doc.setFieldValue(fieldId, '채운 값');
  doc.insertTextInCell(0, 1, 0, 2, 0, 0, '첫 줄셋째 줄');
  doc.splitParagraphInCell(0, 1, 0, 2, 0, 3);
  doc.splitParagraphInCell(0, 1, 0, 2, 1, 0);
  return doc;
}

describe('SPEC-001 하이라이트 대상 → 사각형', () => {
  it('문단 블록 전체를 고르면 문단 글자 전체 사각형을 준다', () => {
    const doc = openFixture('notice.hwpx');
    const length = doc.getParagraphLength(0, 6);
    expect(rectsOf(doc, paragraphAt(6), {})).toEqual(
      selectionRects(doc, { section: 0, startParagraph: 6, startOffset: 0, endParagraph: 6, endOffset: length }),
    );
  });

  it('문단 일부(start·end)는 블록 text 의 그 글자만 덮는다', () => {
    const doc = openFixture('notice.hwpx');
    const text = '회신 기한: 2026. 11. 14.(금)까지 참석 인원을 회신하여 주시기 바랍니다.';
    const start = text.indexOf('2026. 11. 14.');
    expect(rectsOf(doc, paragraphAt(10), { start, end: start + 13 })).toEqual(
      selectionRects(doc, { section: 0, startParagraph: 10, startOffset: 7, endParagraph: 10, endOffset: 20 }),
    );
  });

  it('BMP 밖 글자(이모지) 뒤 범위는 rhwp 글자 위치로 바꿔 고른다', () => {
    const doc = createBlankDocument();
    doc.insertText(0, 0, 0, '가😀나다');
    // JS 문자열에서 "나다" 는 3~5, rhwp 글자 위치로는 2~4
    expect(rectsOf(doc, paragraphAt(0), { start: 3, end: 5 })).toEqual(
      selectionRects(doc, { section: 0, startParagraph: 0, startOffset: 2, endParagraph: 0, endOffset: 4 }),
    );
  });

  it('표 칸(cell)을 고르면 그 칸 글자를 덮는다', () => {
    const doc = openFixture('notice.hwpx');
    expect(rectsOf(doc, isTable, { cell: { row: 2, col: 2 } })).toEqual(
      selectionRects(doc, {
        section: 0,
        cell: { parentParagraph: 11, controlIndex: 0, cellIndex: 8 },
        startParagraph: 0,
        startOffset: 0,
        endParagraph: 0,
        endOffset: 8,
      }),
    );
  });

  it('표 블록에 cell 이 없으면 표 전체를 사각형 하나로 덮는다', () => {
    const doc = openFixture('notice.hwpx');
    const table = z
      .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
      .parse(JSON.parse(doc.getTableBBox(0, 11, 0)));
    const [rect, ...rest] = rectsOf(doc, isTable, {});

    expect(rest).toHaveLength(0);
    expect(rect?.x).toBeCloseTo(table.x, 0);
    expect(rect?.y).toBeCloseTo(table.y, 0);
    expect(rect?.width).toBeCloseTo(table.width, 0);
    expect(rect?.height).toBeCloseTo(table.height, 0);
  });

  it('칸 안 여러 문단에 걸친 범위는 빈 문단을 건너 문단마다 사각형을 준다', () => {
    const doc = tableDocument();
    // 칸 text = "첫 줄\n\n셋째 줄"
    const rects = rectsOf(doc, isTable, { cell: { row: 1, col: 0 } });
    const caretX = (p: number) => z.object({ x: z.number() }).parse(JSON.parse(doc.getCursorRectInCell(0, 1, 0, 2, p, 0))).x;

    expect(rects).toHaveLength(2);
    expect(rects[0]?.x).toBeCloseTo(caretX(0), 1);
    expect(rects[1]?.x).toBeCloseTo(caretX(2), 1);
    // 첫 문단 줄은 칸 오른쪽 끝이 아니라 "첫 줄" 끝 글자까지만
    const endX = z.object({ x: z.number() }).parse(JSON.parse(doc.getCursorRectInCell(0, 1, 0, 2, 0, 3))).x;
    expect((rects[0]?.x ?? 0) + (rects[0]?.width ?? 0)).toBeCloseTo(endX, 1);
  });

  it('누름틀 블록은 값 글자를 덮는다(표 칸 안 누름틀 포함)', () => {
    const doc = tableDocument();
    expect(rectsOf(doc, isField, {})).toEqual(
      selectionRects(doc, {
        section: 0,
        cell: { parentParagraph: 1, controlIndex: 0, cellIndex: 1 },
        startParagraph: 0,
        startOffset: 3,
        endParagraph: 0,
        endOffset: 7,
      }),
    );
  });

  it('값이 빈 누름틀은 그 자리에 그려진 안내문을 덮는다', () => {
    const doc = openFixture('notice.hwpx');
    const guide = z
      .object({ runs: z.array(z.object({ text: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number() })) })
      .parse(JSON.parse(doc.getPageTextLayout(0)))
      .runs.find((run) => run.text === '받는 곳을 넣으세요');

    expect(rectsOf(doc, isField, {})).toEqual([
      { pageIndex: 0, x: guide?.x, y: guide?.y, width: guide?.w, height: guide?.h },
    ]);
  });

  it('범위가 블록 글자 밖이거나 비어 있으면 블록 id 와 글자 수를 담은 오류를 낸다', () => {
    const doc = openFixture('notice.hwpx');
    expect(() => rectsOf(doc, paragraphAt(0), { start: 2, end: 9 })).toThrow(
      'b1: 글자 범위가 맞지 않습니다(start 2, end 9, 글자 수 5). 0 ≤ start < end ≤ 글자 수로 주세요.',
    );
    expect(() => rectsOf(doc, paragraphAt(0), { start: 3, end: 3 })).toThrow('글자 범위가 맞지 않습니다');
    expect(() => rectsOf(doc, isTable, { cell: { row: 0, col: 0 }, end: 99 })).toThrow('b1 칸(0,0): 글자 범위가 맞지 않습니다');
  });

  it('표에 없는 칸, 표가 아닌 블록의 cell, cell 없는 표 범위는 오류다', () => {
    const doc = openFixture('notice.hwpx');
    expect(() => rectsOf(doc, isTable, { cell: { row: 5, col: 0 } })).toThrow('b1: 표에 없는 칸입니다(row 5, col 0). 이 표는 3행 3열');
    expect(() => rectsOf(doc, paragraphAt(0), { cell: { row: 0, col: 0 } })).toThrow('b1: 표 블록이 아니라 cell 을 줄 수 없습니다.');
    expect(() => rectsOf(doc, isTable, { start: 0, end: 1 })).toThrow('b1: 표 블록에서 글자 범위를 고르려면 cell 을 함께 주세요.');
  });

  it('칸 text 위치를 칸 문단과 문단 안 위치로 바꾼다', () => {
    const paragraphs = ['첫 줄', '', '셋째 줄'];
    expect(cellPosition(paragraphs, 0)).toEqual({ paragraph: 0, offset: 0 });
    expect(cellPosition(paragraphs, 3)).toEqual({ paragraph: 0, offset: 3 });
    expect(cellPosition(paragraphs, 4)).toEqual({ paragraph: 1, offset: 0 });
    expect(cellPosition(paragraphs, 5)).toEqual({ paragraph: 2, offset: 0 });
    expect(cellPosition(paragraphs, 9)).toEqual({ paragraph: 2, offset: 4 });
  });
});
