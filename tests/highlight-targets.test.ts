import type { HwpDocument } from '@rhwp/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Block } from '../src/core/block-schema.ts';
import { extractBlocks } from '../src/core/blocks.ts';
import { selectionRects } from '../src/core/highlight-rects.ts';
import { BlockIdTable } from '../src/core/block-ids.ts';
import { cellPosition, fieldPlace, guideRects, highlightTargets, type HighlightTarget } from '../src/core/highlight-targets.ts';
import { createBlankDocument } from '../src/core/rhwp-node.ts';
import { openFixture } from './fixtures.ts';

function blockIndex(blocks: Block[], match: (block: Block) => boolean): number {
  const index = blocks.findIndex(match);
  if (index === -1) throw new Error('블록이 없다');
  return index;
}

/** match 블록 하나를 대상으로(서버처럼 id 표 위치를 붙여) 사각형을 구한다 */
function rectsOf(doc: HwpDocument, match: (block: Block) => boolean, target: Omit<HighlightTarget, 'id' | 'anchor'>) {
  const blocks = extractBlocks(doc);
  const anchor = BlockIdTable.assign(blocks).anchor(`b${blockIndex(blocks, match) + 1}`);
  if (anchor === undefined) throw new Error('위치가 없다');
  const { rects } = highlightTargets(doc, blocks, [{ id: 'b1', anchor, ...target }]);
  return rects[0] ?? [];
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

  it('글자 위치는 유니코드 글자 단위라 BMP 밖 글자(이모지·확장 한자) 뒤에서도 rhwp 위치와 같다', () => {
    const doc = createBlankDocument();
    doc.insertText(0, 0, 0, '𠀀😀나다');
    // "나다" 는 글자 위치 2~4 (JS 문자열 위치로는 4~6)
    expect(rectsOf(doc, paragraphAt(0), { start: 2, end: 4 })).toEqual(
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
    const emoji = createBlankDocument();
    emoji.insertText(0, 0, 0, '𠀀😀나다');
    expect(() => rectsOf(emoji, paragraphAt(0), { start: 0, end: 5 })).toThrow('글자 수 4');
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
    expect(cellPosition(['😀가', '나'], 3)).toEqual({ paragraph: 1, offset: 0 });
  });

  it('결과의 쪽은 모든 사각형의 쪽(중복 없이 오름차순)이고, 사각형은 대상 순서를 따른다(PR #14 리뷰)', () => {
    const doc = createBlankDocument();
    doc.insertText(0, 0, 0, '가나다 '.repeat(900));
    doc.splitParagraph(0, 0, 4);
    const blocks = extractBlocks(doc);
    const ids = BlockIdTable.assign(blocks);
    const anchor = (id: string) => {
      const found = ids.anchor(id);
      if (found === undefined) throw new Error('위치가 없다');
      return found;
    };

    // b2 = 쪽을 여러 번 넘는 긴 문단, b1 = 첫 쪽 짧은 문단
    const plan = highlightTargets(doc, blocks, [
      { id: 'b2', anchor: anchor('b2') },
      { id: 'b1', anchor: anchor('b1') },
    ]);

    expect(plan.pages).toEqual(Array.from({ length: doc.pageCount() }, (_, i) => i + 1));
    expect(plan.pages.length).toBeGreaterThan(1);
    expect(plan.rects[1]).toHaveLength(1);
    expect(plan.warnings).toEqual([]);
  });

  it('같은 문단의 두 번째 누름틀은 서버가 보낸 위치의 순번으로 고른다', () => {
    const doc = createBlankDocument();
    doc.insertText(0, 0, 0, '가 나 ');
    doc.insertClickHereField(0, 0, 4, '둘째 안내', '', '둘째', true);
    doc.insertClickHereField(0, 0, 2, '첫째 안내', '', '첫째', true);
    const fields = z.array(z.object({ fieldId: z.number(), name: z.string() })).parse(JSON.parse(doc.getFieldList()));
    for (const { fieldId, name } of fields) doc.setFieldValue(fieldId, name === '첫째' ? '하나' : '둘둘둘');
    const second = z
      .array(z.object({ name: z.string(), startCharIdx: z.number(), endCharIdx: z.number() }))
      .parse(JSON.parse(doc.getFieldList()))
      .find((f) => f.name === '둘째');
    if (second === undefined) throw new Error('누름틀이 없다');

    const rects = highlightTargets(doc, extractBlocks(doc), [
      { id: 'b3', anchor: { section: 0, paragraph: 0, part: 'field:1' } },
    ]).rects[0];

    expect(rects).toEqual(
      selectionRects(doc, { section: 0, startParagraph: 0, startOffset: second.startCharIdx, endParagraph: 0, endOffset: second.endCharIdx }),
    );
  });

  it('빈 누름틀 안내문 자리를 못 찾으면 누름틀 자리에 표시하고 그 사실을 결과에 남긴다', () => {
    const doc = createBlankDocument();
    doc.insertText(0, 0, 0, '수신 ');
    doc.insertClickHereField(0, 0, 3, '', '', '수신', true);

    const plan = highlightTargets(doc, extractBlocks(doc), [{ id: 'b2', anchor: { section: 0, paragraph: 0, part: 'field:0' } }]);

    expect(plan.rects[0]).toHaveLength(1);
    expect(plan.warnings).toEqual(['b2: 빈 누름틀의 안내문 자리를 찾지 못해 누름틀 자리에 글자 하나 크기로 표시했습니다.']);
  });
});

describe('SPEC-001 빈 누름틀 안내문 자리 (가짜 글자 배치)', () => {
  const caret = { pageIndex: 2, x: 100, y: 50, height: 13 };
  const run = (text: string, x: number, y: number, w: number) => ({ text, x, y, w, h: 13 });

  it('안내문이 run 하나면 그 자리', () => {
    expect(guideRects([run('수신', 40, 50, 30), run('받는 곳을 넣으세요', 100, 50, 117)], '받는 곳을 넣으세요', caret)).toEqual([
      { pageIndex: 2, x: 100, y: 50, width: 117, height: 13 },
    ]);
  });

  it('안내문이 줄바꿈 등으로 여러 run 으로 나뉘면 이어 붙여 줄마다 사각형을 준다', () => {
    const runs = [run('받는 곳을 ', 100, 50, 60), run('', 160, 50, 0), run('넣으세요', 20, 64, 50), run('다음 글', 70, 64, 40)];
    expect(guideRects(runs, '받는 곳을 넣으세요', caret)).toEqual([
      { pageIndex: 2, x: 100, y: 50, width: 60, height: 13 },
      { pageIndex: 2, x: 20, y: 64, width: 50, height: 13 },
    ]);
  });

  it('캐럿 자리에서 시작하지 않거나 끝까지 맞지 않으면 찾지 못한다', () => {
    expect(guideRects([run('받는 곳을 넣으세요', 300, 50, 117)], '받는 곳을 넣으세요', caret)).toBeUndefined();
    expect(guideRects([run('받는 곳을 ', 100, 50, 60), run('다른 글', 20, 64, 50)], '받는 곳을 넣으세요', caret)).toBeUndefined();
  });
});

describe('SPEC-001 누름틀이 든 자리', () => {
  const field = (path?: Array<{ type?: string; controlIndex: number; cellIndex: number; paraIndex: number }>) => ({
    fieldType: 'clickhere',
    guide: '',
    startCharIdx: 0,
    location: { sectionIndex: 0, paraIndex: 3, ...(path === undefined ? {} : { path }) },
  });
  const table: Block = { kind: 'table', section: 0, paragraph: 3, controlIndex: 0, page: 1, rowCount: 1, colCount: 1, cells: [] };

  it('본문이면 그 문단, 표 칸이면 칸 위치와 칸 안 문단', () => {
    expect(fieldPlace('b1', field(), 0, [])).toEqual({ paragraph: 3 });
    expect(fieldPlace('b1', field([{ type: 'cell', controlIndex: 0, cellIndex: 2, paraIndex: 1 }]), 0, [table])).toEqual({
      cell: { parentParagraph: 3, controlIndex: 0, cellIndex: 2 },
      paragraph: 1,
    });
  });

  it('표 칸이 아닌 곳(글상자 등)이나 표 안 표에 든 누름틀은 분명한 오류다', () => {
    const textbox = field([{ type: 'textbox', controlIndex: 1, cellIndex: 0, paraIndex: 0 }]);
    expect(() => fieldPlace('b1', textbox, 0, [table])).toThrow('b1: 표 칸이 아닌 곳(글상자 등)에 든 누름틀은 아직 하이라이트할 수 없습니다.');
    // 경로 종류가 없어도 그 자리에 본문 표가 없으면 표 칸이 아니다
    expect(() => fieldPlace('b1', field([{ controlIndex: 1, cellIndex: 0, paraIndex: 0 }]), 0, [table])).toThrow('표 칸이 아닌 곳');
    const nested = field([
      { type: 'cell', controlIndex: 0, cellIndex: 0, paraIndex: 0 },
      { type: 'cell', controlIndex: 0, cellIndex: 1, paraIndex: 0 },
    ]);
    expect(() => fieldPlace('b1', nested, 0, [table])).toThrow('b1: 표 안 표에 든 누름틀은 아직 하이라이트할 수 없습니다.');
  });
});
