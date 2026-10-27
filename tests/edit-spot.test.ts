import type { HwpDocument } from '@rhwp/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { anchorsOf, type BlockAnchor } from '../src/core/block-ids.ts';
import type { Block } from '../src/core/block-schema.ts';
import { extractBlocks } from '../src/core/blocks.ts';
import {
  BLOCK_CHANGED_WHILE_EDITING,
  blockAtHit,
  CROSSES_FIELD_IN_VIEWER,
  editSpotAt,
  followEdit,
  replaceEditAt,
  spotBox,
  type EditSpot,
  type Hit,
} from '../src/core/edit-spot.ts';
import { blockBoxes } from '../src/core/highlight-targets.ts';
import type { SelectionRect } from '../src/core/highlight-rects.ts';
import { noParagraphChanges } from '../src/core/paragraph-changes.ts';
import { createBlankDocument } from '../src/core/rhwp-node.ts';
import { openFixture } from './fixtures.ts';

const B11_TEXT = '회신 기한: 2026. 11. 14.(금)까지 참석 인원을 회신하여 주시기 바랍니다.';

function anchorWhere(blocks: Block[], match: (block: Block) => boolean): BlockAnchor {
  const index = blocks.findIndex(match);
  const anchor = anchorsOf(blocks)[index];
  if (anchor === undefined) throw new Error('블록이 없다');
  return anchor;
}

const paragraphAt = (paragraph: number) => (block: Block) => block.kind === 'paragraph' && block.paragraph === paragraph;
const isField = (block: Block) => block.kind === 'field';
const isTable = (block: Block) => block.kind === 'table';

/** 사각형 가운데 점(쪽 px) */
const centerOf = (rect: SelectionRect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

function boxOf(doc: HwpDocument, blocks: Block[], anchor: BlockAnchor): SelectionRect {
  const [box] = blockBoxes(doc, blocks, [anchor]).boxes;
  if (box === undefined) throw new Error('블록 자리가 없다');
  return box;
}

function cellBox(doc: HwpDocument, section: number, paragraph: number, controlIndex: number, cellIndex: number): SelectionRect {
  const boxes = z
    .array(z.object({ cellIdx: z.number(), pageIndex: z.number(), x: z.number(), y: z.number(), w: z.number(), h: z.number() }))
    .parse(JSON.parse(doc.getTableCellBboxes(section, paragraph, controlIndex)));
  const box = boxes.find((candidate) => candidate.cellIdx === cellIndex);
  if (box === undefined) throw new Error('칸이 없다');
  return { pageIndex: box.pageIndex, x: box.x, y: box.y, width: box.w, height: box.h };
}

// 앞 문단 + 2×2 표. 칸(0,1) 에 "값: " 뒤 누름틀(값 "채운 값")
function tableFieldDocument(): HwpDocument {
  const doc = createBlankDocument();
  doc.insertText(0, 0, 0, '앞 문단');
  doc.createTable(0, 0, 4, 2, 2);
  doc.insertTextInCell(0, 1, 0, 1, 0, 0, '값: ');
  doc.insertClickHereFieldInCell(0, 1, 0, 1, 0, 3, false, '안내', '', '칸필드', true);
  const fieldId = z.array(z.object({ fieldId: z.number() })).parse(JSON.parse(doc.getFieldList()))[0]?.fieldId ?? 0;
  doc.setFieldValue(fieldId, '채운 값');
  return doc;
}

describe('SPEC-006 더블클릭 자리 → 고칠 블록과 커서 위치 (rhwp hitTest)', () => {
  it('문단 글자 위를 고르면 그 문단 블록과 블록 글자 전체, 고른 자리의 글자 위치를 준다', () => {
    const doc = openFixture('notice.hwpx');
    const blocks = extractBlocks(doc);
    const anchor = anchorWhere(blocks, paragraphAt(10));
    const box = boxOf(doc, blocks, anchor);

    const found = editSpotAt(doc, blocks, box.pageIndex, centerOf(box));

    expect(found?.spot).toMatchObject({ anchor, text: B11_TEXT });
    expect(found?.spot.cell).toBeUndefined();
    expect(found?.spot.caret).toBeGreaterThan(0);
    expect(found?.spot.caret).toBeLessThan([...B11_TEXT].length);
    // 마우스 올림 테두리 자리 = 바뀐 블록 표시와 같은 블록 사각형
    expect(found?.box).toEqual(box);
  });

  it('블록 밖(마지막 문단 아래 빈 곳)은 hitTest 가 가까운 문단을 주어도 고르지 않는다', () => {
    const doc = openFixture('notice.hwpx');
    const blocks = extractBlocks(doc);

    expect(editSpotAt(doc, blocks, 0, { x: 200, y: 900 })).toBeUndefined();
  });

  it('표 칸을 고르면 표 블록과 그 칸(row·col), 칸 글자를 주고 테두리는 칸 사각형이다', () => {
    const doc = openFixture('notice.hwpx');
    const blocks = extractBlocks(doc);
    const table = blocks.find(isTable);
    if (table?.kind !== 'table') throw new Error('표가 없다');
    const cellIndex = table.cells.findIndex((cell) => cell.row === 1 && cell.col === 1);
    const box = cellBox(doc, 0, table.paragraph, table.controlIndex, cellIndex);

    const found = editSpotAt(doc, blocks, box.pageIndex, centerOf(box));

    expect(found?.spot).toMatchObject({ anchor: anchorWhere(blocks, isTable), cell: { row: 1, col: 1 }, text: table.cells[cellIndex]?.text });
    expect(found?.box).toEqual(box);
  });

  it('문단 안 누름틀 값 위를 고르면 누름틀 블록과 그 값을 준다', () => {
    const doc = openFixture('notice.hwpx');
    doc.setFieldValue(1, '각 동 주민센터');
    const blocks = extractBlocks(doc);
    const anchor = anchorWhere(blocks, isField);
    const box = boxOf(doc, blocks, anchor);

    const found = editSpotAt(doc, blocks, box.pageIndex, centerOf(box));

    expect(found?.spot).toMatchObject({ anchor, text: '각 동 주민센터' });
  });

  it('빈 누름틀은 안내문 자리를 고르면 빈 값으로 고친다', () => {
    const doc = openFixture('notice.hwpx');
    const blocks = extractBlocks(doc);
    const anchor = anchorWhere(blocks, isField);
    const box = boxOf(doc, blocks, anchor);

    const found = editSpotAt(doc, blocks, box.pageIndex, centerOf(box));

    expect(found?.spot).toMatchObject({ anchor, text: '', caret: 0 });
  });

  it('표 칸 안 누름틀 값 위를 고르면 칸이 아니라 누름틀 블록이다', () => {
    const doc = tableFieldDocument();
    const blocks = extractBlocks(doc);
    const anchor = anchorWhere(blocks, isField);
    const box = boxOf(doc, blocks, anchor);

    const found = editSpotAt(doc, blocks, box.pageIndex, centerOf(box));

    expect(found?.spot).toMatchObject({ anchor, text: '채운 값' });
  });

  it('빈 문단 블록(새 문서 첫 블록)도 고를 수 있다', () => {
    const doc = createBlankDocument();
    const blocks = extractBlocks(doc);
    const caret = z.object({ x: z.number(), y: z.number(), height: z.number() }).parse(JSON.parse(doc.getCursorRect(0, 0, 0)));

    const found = editSpotAt(doc, blocks, 0, { x: caret.x + 100, y: caret.y + caret.height / 2 });

    expect(found?.spot).toMatchObject({ anchor: { section: 0, paragraph: 0, part: 'text' }, text: '', caret: 0 });
  });
});

describe('SPEC-006 hitTest 결과 → 본문 블록(문단·표)', () => {
  const blocks: Block[] = [
    { kind: 'paragraph', section: 0, paragraph: 0, page: 1, text: '가나다' },
    {
      kind: 'table',
      section: 0,
      paragraph: 1,
      controlIndex: 0,
      page: 1,
      rowCount: 1,
      colCount: 2,
      cells: [
        { row: 0, col: 0, text: '첫 칸', rowLabel: '첫 칸' },
        { row: 0, col: 1, text: 'ab\ncde', rowLabel: '첫 칸' },
      ],
    },
  ];
  const caret = { pageIndex: 0, x: 0, y: 0, height: 10 };

  it('칸 안 둘째 문단의 글자 위치는 칸 글자(문단을 \\n 으로 이음) 안 위치로 바꾼다', () => {
    const hit: Hit = {
      sectionIndex: 0,
      paragraphIndex: 1,
      charOffset: 2,
      parentParaIndex: 1,
      controlIndex: 0,
      cellIndex: 1,
      cellParaIndex: 1,
      cellPath: [{ controlIndex: 0, cellIndex: 1, cellParaIndex: 1 }],
      cursorRect: caret,
    };

    expect(blockAtHit(hit, blocks)).toMatchObject({ index: 1, cell: { index: 1, row: 0, col: 1 }, offset: 5 });
  });

  it('표 안 표 칸이나 블록이 아닌 문단(처음부터 빈 문단)은 고르지 않는다', () => {
    const nested: Hit = {
      sectionIndex: 0,
      paragraphIndex: 0,
      charOffset: 0,
      parentParaIndex: 1,
      controlIndex: 0,
      cellIndex: 0,
      cellParaIndex: 0,
      cellPath: [
        { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 },
        { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 },
      ],
      cursorRect: caret,
    };
    expect(blockAtHit(nested, blocks)).toBeUndefined();
    expect(blockAtHit({ sectionIndex: 0, paragraphIndex: 5, charOffset: 0, cursorRect: caret }, blocks)).toBeUndefined();
  });
});

describe('SPEC-006 입력칸 글자 → 사람 편집(replace_text 바뀐 범위만)', () => {
  const doc = openFixture('notice.hwpx');
  doc.setFieldValue(1, '각 동 주민센터');
  const blocks = extractBlocks(doc);
  const b11: EditSpot = { anchor: anchorWhere(blocks, paragraphAt(10)), text: B11_TEXT, caret: 0 };
  const receiver = blocks.find(isField);
  const paragraph1 = blocks.find(paragraphAt(1));
  if (receiver?.kind !== 'field' || paragraph1?.kind !== 'paragraph') throw new Error('수신 문단이 없다');
  const line: EditSpot = { anchor: anchorWhere(blocks, paragraphAt(1)), text: paragraph1.text, caret: 0 };

  it('앞뒤 같은 글자는 빼고 바뀐 범위만 블록 위치 대상으로 보낸다', () => {
    expect(replaceEditAt(blocks, b11, B11_TEXT.replace('14.', '7.'))).toEqual({
      kind: 'replace_text',
      target: { anchor: b11.anchor, start: 17, end: 19 },
      text: '7',
    });
  });

  it('글자가 같으면 편집하지 않는다', () => {
    expect(replaceEditAt(blocks, b11, B11_TEXT)).toBeUndefined();
  });

  it('표 칸은 칸(row·col)을 함께 보낸다', () => {
    const table = blocks.find(isTable);
    if (table?.kind !== 'table') throw new Error('표가 없다');
    const cell = table.cells.find((candidate) => candidate.row === 1 && candidate.col === 1);
    const spot: EditSpot = { anchor: anchorWhere(blocks, isTable), cell: { row: 1, col: 1 }, text: cell?.text ?? '', caret: 0 };

    expect(replaceEditAt(blocks, spot, `${spot.text}!`)).toMatchObject({ target: { anchor: spot.anchor, cell: { row: 1, col: 1 } }, text: '!' });
  });

  it('문단 입력칸에서 바뀐 범위가 누름틀 값 안에만 있으면 그 누름틀 값 편집으로 보낸다', () => {
    // "수신  각 동 주민센터" 의 "주민센터" → "행정복지센터"
    const after = paragraph1.text.replace('주민센터', '행정복지센터');
    const span = receiver.span;
    if (span === undefined) throw new Error('누름틀 자리가 없다');

    expect(replaceEditAt(blocks, line, after)).toEqual({
      kind: 'replace_text',
      target: { anchor: anchorWhere(blocks, isField), start: 4, end: 6 },
      text: '행정복지',
    });
    expect(paragraph1.text.slice(span.start, span.end)).toBe('각 동 주민센터');
  });

  it('문단 입력칸에서 바뀐 범위가 누름틀 값과 그 바깥에 걸치면 보내지 않고 거부한다', () => {
    // "수신  각" → "받는 곳 서" : 누름틀 앞 글자와 값 첫 글자를 한 번에 바꿈
    const after = `받는 곳 서${paragraph1.text.slice(paragraph1.text.indexOf('각') + 1)}`;

    expect(() => replaceEditAt(blocks, line, after)).toThrow(CROSSES_FIELD_IN_VIEWER);
  });

  it('누름틀 값 바로 앞·뒤에 넣는 것은 값 밖 문단 글자 편집이다(서버 걸침 판정과 같다)', () => {
    const at = paragraph1.text.length;
    expect(replaceEditAt(blocks, line, `${paragraph1.text}.`)).toEqual({
      kind: 'replace_text',
      target: { anchor: line.anchor, start: at, end: at },
      text: '.',
    });
  });
});

describe('SPEC-006 입력칸을 다시 둘 자리(편집 뒤 블록 새 자리)', () => {
  it('문단은 첫 글자 사각형, 표는 그 칸 사각형, 빈 문단은 커서 줄 자리이고 블록이 없으면 없다', () => {
    const doc = tableFieldDocument();
    const blocks = extractBlocks(doc);
    const paragraph = anchorWhere(blocks, paragraphAt(0));
    const table = anchorWhere(blocks, isTable);

    expect(spotBox(doc, blocks, { anchor: paragraph, text: '앞 문단', caret: 0 })).toEqual(boxOf(doc, blocks, paragraph));
    expect(spotBox(doc, blocks, { anchor: table, cell: { row: 0, col: 1 }, text: '', caret: 0 })).toEqual(cellBox(doc, 0, table.paragraph, 0, 1));
    expect(spotBox(doc, blocks, { anchor: { ...paragraph, paragraph: 99 }, text: '', caret: 0 })).toBeUndefined();
    doc.free();
  });

  it('빈 문단 블록은 커서 줄의 단 폭이다', () => {
    const doc = createBlankDocument();
    const blocks = extractBlocks(doc);
    const box = spotBox(doc, blocks, { anchor: anchorWhere(blocks, paragraphAt(0)), text: '', caret: 0 });

    expect(box?.pageIndex).toBe(0);
    expect(box?.width).toBeGreaterThan(100);
    doc.free();
  });
});

describe('SPEC-006 같은 글자가 이어지는 곳은 입력칸 커서로 바뀐 자리를 정한다', () => {
  // "가" + 누름틀(값 "가나")
  const doc = createBlankDocument();
  doc.insertText(0, 0, 0, '가');
  doc.insertClickHereField(0, 0, 1, '', '', '값', true);
  const fieldId = z.array(z.object({ fieldId: z.number() })).parse(JSON.parse(doc.getFieldList()))[0]?.fieldId ?? 0;
  doc.setFieldValue(fieldId, '가나');
  const blocks = extractBlocks(doc);
  const paragraph = blocks.find(paragraphAt(0));
  if (paragraph?.kind !== 'paragraph') throw new Error('문단이 없다');
  const line: EditSpot = { anchor: anchorWhere(blocks, paragraphAt(0)), text: paragraph.text, caret: 0 };

  it('누름틀 값 밖 "가" 를 지우면(커서 0) 누름틀 값은 그대로 두고 문단 글자를 지운다', () => {
    expect(paragraph.text).toBe('가가나');
    expect(replaceEditAt(blocks, line, '가나', 0)).toEqual({ kind: 'replace_text', target: { anchor: line.anchor, start: 0, end: 1 }, text: '' });
  });

  it('누름틀 값 안 "가" 를 지우면(커서 1) 누름틀 값 편집이다', () => {
    expect(replaceEditAt(blocks, line, '가나', 1)).toEqual({
      kind: 'replace_text',
      target: { anchor: anchorWhere(blocks, isField), start: 0, end: 1 },
      text: '',
    });
  });
});

describe('SPEC-006 AC-8 입력칸이 열린 동안 Claude 편집을 따라가고, 같은 블록이 바뀌었으면 거부한다', () => {
  const doc = openFixture('notice.hwpx');
  const blocks = extractBlocks(doc);
  const b11: EditSpot = { anchor: anchorWhere(blocks, paragraphAt(10)), text: B11_TEXT, caret: 0 };

  it('Claude 가 같은 블록 글자를 바꿨으면 사람 적용을 거부한다', () => {
    const changed = blocks.map((block) => (block.kind === 'paragraph' && block.paragraph === 10 ? { ...block, text: 'Claude 가 고침' } : block));

    expect(() => replaceEditAt(changed, b11, B11_TEXT.replace('14.', '7.'))).toThrow(BLOCK_CHANGED_WHILE_EDITING);
    // 사람이 고친 것이 없으면 거부 문구 없이 그냥 닫는다
    expect(replaceEditAt(changed, b11, B11_TEXT)).toBeUndefined();
  });

  it('Claude 가 앞에 문단을 넣었으면 블록 위치를 옮겨 따라가고, 글자가 그대로면 옮긴 위치로 보낸다', () => {
    const changes = { ...noParagraphChanges(), inserted: [{ section: 0, paragraph: 2, part: 'text' }] };
    const followed = followEdit(b11, changes);
    const shifted = blocks.map((block) => (block.paragraph >= 2 ? { ...block, paragraph: block.paragraph + 1 } : block));

    expect(followed?.anchor).toEqual({ ...b11.anchor, paragraph: 11 });
    expect(followed === undefined ? undefined : replaceEditAt(shifted, followed, B11_TEXT.replace('14.', '7.'))).toMatchObject({
      target: { anchor: { section: 0, paragraph: 11, part: 'text' } },
    });
  });

  it('Claude 가 그 블록 문단을 지웠으면 따라갈 자리가 없다', () => {
    expect(followEdit(b11, { ...noParagraphChanges(), deletedParagraphs: [{ section: 0, paragraph: 10 }] })).toBeUndefined();
  });

  it('문단 위치를 바꾸지 않은 편집 뒤에는 자리가 그대로다', () => {
    expect(followEdit(b11, undefined)).toEqual(b11);
  });
});
