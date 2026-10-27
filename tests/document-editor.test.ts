// SPEC-002 편집 공용 경로(core/document-editor.ts)와 replace_text 적용(core/edit-operations.ts). 뷰어와 같은 코드를 Node 의 rhwp 로 돌린다.
import type { HwpDocument } from '@rhwp/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BlockIdTable } from '../src/core/block-ids.ts';
import type { Block } from '../src/core/block-schema.ts';
import { DocumentEditor } from '../src/core/document-editor.ts';
import { UNDO_LIMIT } from '../src/core/edit-history.ts';
import { MAX_REPLACE_TARGETS, type EditOperation } from '../src/core/edit-operations.ts';
import { charLook, listFields, paraShapeIdOf, replaceFieldText } from '../src/core/edits.ts';
import { blockBoxes } from '../src/core/highlight-targets.ts';
import { createBlankDocument } from '../src/core/rhwp-node.ts';
import { planMove, type MoveWhere } from '../src/server/move-plan.ts';
import { openFixture } from './fixtures.ts';

const S = 0;

const charShapeIdAt = (doc: HwpDocument, paragraph: number, offset: number): unknown =>
  JSON.parse(doc.getCharPropertiesAt(S, paragraph, offset)).charShapeId;
const cellCharShapeIdAt = (doc: HwpDocument, paragraph: number, control: number, cell: number, offset: number): unknown =>
  JSON.parse(doc.getCellCharPropertiesAt(S, paragraph, control, cell, 0, offset)).charShapeId;

/** 블록 id(문서를 연 때 순서 b1, b2 …)로 편집 대상을 만든다 */
function targetOf(editor: DocumentEditor, id: string, extra: { cell?: { row: number; col: number }; start?: number; end?: number } = {}) {
  const anchor = BlockIdTable.assign(editor.blocks).anchor(id);
  if (anchor === undefined) throw new Error(`${id} 가 없다`);
  return { id, anchor, ...extra };
}

const replace = (
  editor: DocumentEditor,
  id: string,
  text: string,
  extra: { cell?: { row: number; col: number }; start?: number; end?: number } = {},
): EditOperation => ({ kind: 'replace_text', targets: [targetOf(editor, id, extra)], text });

type Spot = { id: string; cell?: { row: number; col: number }; start?: number; end?: number };

/** 여러 자리를 한 편집으로 바꾸는 replace_text(SPEC-005) */
const replaceMany = (editor: DocumentEditor, spots: Spot[], text: string): EditOperation => ({
  kind: 'replace_text',
  targets: spots.map(({ id, ...extra }) => targetOf(editor, id, extra)),
  text,
});

/** 서버와 같은 방법(planMove)으로 move_blocks 편집을 만든다. id 는 지금 블록 순서로 새로 붙인다 */
function move(editor: DocumentEditor, ids: string[], reference: string, where: MoveWhere): EditOperation {
  const { section, start, end, before, blocks } = planMove(BlockIdTable.assign(editor.blocks), ids, reference, where);
  return { kind: 'move_blocks', section, start, end, before, blocks };
}

/** 번호 문단의 "번호 앞 글자" 목록 */
const numbered = (blocks: Block[]) =>
  blocks.flatMap((block) => (block.kind === 'paragraph' && block.number !== undefined ? [`${block.number} ${block.text.slice(0, 5)}`] : []));

function textOf(block: Block | undefined): string {
  if (block === undefined) return '(없음)';
  switch (block.kind) {
    case 'paragraph':
      return block.text;
    case 'field':
      return block.value;
    case 'table':
      return block.cells.map((cell) => cell.text).join(' | ');
  }
}
const blockText = (editor: DocumentEditor, index: number) => textOf(editor.blocks[index]);

/** "가나다라마바" 에서 "다라" 만 굵게 한 문서 */
function mixedEditor(): DocumentEditor {
  const doc = createBlankDocument();
  doc.insertText(S, 0, 0, '가나다라마바');
  doc.applyCharFormat(S, 0, 2, 4, JSON.stringify({ bold: true }));
  return new DocumentEditor(doc);
}

describe('SPEC-002 replace_text (편집 공용 경로)', () => {
  it('AC-1 문단 일부를 바꾸고, 바뀐 글자는 바뀌는 자리 첫 글자의 글자 모양을 따른다', () => {
    const editor = mixedEditor();
    const boldId = charShapeIdAt(editor.doc, 0, 2);

    const changed = editor.edit(replace(editor, 'b1', 'XYZ', { start: 2, end: 4 }), editor.depth).changed;

    expect(blockText(editor, 0)).toBe('가나XYZ마바');
    expect([2, 3, 4].map((offset) => charShapeIdAt(editor.doc, 0, offset))).toEqual([boldId, boldId, boldId]);
    expect(charShapeIdAt(editor.doc, 0, 5)).not.toBe(boldId);
    expect(changed.map(({ block }) => textOf(block))).toEqual(['가나XYZ마바']);
  });

  it('AC-1 start·end 가 없으면 문단 전체를 바꾸고 첫 글자 모양을 따른다', () => {
    const doc = openFixture('notice.hwpx');
    doc.applyCharFormat(S, 10, 0, 1, JSON.stringify({ italic: true }));
    const editor = new DocumentEditor(doc);
    const firstId = charShapeIdAt(doc, 10, 0);

    editor.edit(replace(editor, 'b11', '회신 기한: 2026. 11. 7.(금)까지 회신하여 주시기 바랍니다.'), editor.depth);

    expect(blockText(editor, 10)).toBe('회신 기한: 2026. 11. 7.(금)까지 회신하여 주시기 바랍니다.');
    expect(charShapeIdAt(doc, 10, 20)).toBe(firstId);
  });

  it('AC-1 표 칸 글자를 바꾸고 칸 첫 글자 모양을 따른다', () => {
    const doc = openFixture('notice.hwpx');
    // b12 표의 (1,1) 칸 "11. 20.(목) 14:00" 은 칸 번호 4
    doc.applyCharFormatInCell(S, 11, 0, 4, 0, 4, 7, JSON.stringify({ bold: true }));
    const editor = new DocumentEditor(doc);
    const boldId = cellCharShapeIdAt(doc, 11, 0, 4, 4);

    const changed = editor.edit(replace(editor, 'b12', '21.', { cell: { row: 1, col: 1 }, start: 4, end: 7 }), editor.depth).changed;

    const table = changed[0]?.block;
    expect(table?.kind === 'table' ? table.cells.find((c) => c.row === 1 && c.col === 1)?.text : undefined).toBe('11. 21.(목) 14:00');
    expect([4, 5, 6].map((offset) => cellCharShapeIdAt(doc, 11, 0, 4, offset))).toEqual([boldId, boldId, boldId]);
  });

  it('AC-1 누름틀 값을 바꾸고 값 첫 글자 모양을 따른다(빈 누름틀은 값을 넣는다)', () => {
    const editor = new DocumentEditor(openFixture('application.hwpx'));
    // b7 = 신청인 누름틀(문단 5)
    editor.edit(replace(editor, 'b7', '홍길동'), editor.depth);
    expect(blockText(editor, 6)).toBe('홍길동');
    const field = listFields(editor.doc).find((f) => f.name === '신청인');
    if (field === undefined) throw new Error('신청인 누름틀이 없다');
    editor.doc.applyCharFormat(S, 5, field.startCharIdx, field.startCharIdx + 3, JSON.stringify({ bold: true }));
    const boldId = charShapeIdAt(editor.doc, 5, field.startCharIdx);

    editor.edit(replace(editor, 'b7', '김철수입니다'), editor.depth);

    expect(blockText(editor, 6)).toBe('김철수입니다');
    expect(charShapeIdAt(editor.doc, 5, field.startCharIdx + 5)).toBe(boldId);
  });

  it('누름틀 값 안 위치(start = end)에 넣고, 같은 문단의 둘째 누름틀은 위치 순번으로 고른다', () => {
    const doc = createBlankDocument();
    doc.insertText(S, 0, 0, '성명  날짜 ');
    doc.insertClickHereField(S, 0, 3, '이름', '', '성명', true);
    doc.insertClickHereField(S, 0, 7, '날짜', '', '날짜', true);
    const editor = new DocumentEditor(doc);
    const fieldIds = editor.blocks.flatMap((block, i) => (block.kind === 'field' ? [`b${i + 1}`] : []));
    expect(fieldIds).toHaveLength(2);
    const [, second = ''] = fieldIds;

    editor.edit(replace(editor, second, '11월'), editor.depth);
    editor.edit(replace(editor, second, ' 7일', { start: 3, end: 3 }), editor.depth);

    expect(editor.blocks.flatMap((block) => (block.kind === 'field' ? [`${block.name}=${block.value}`] : []))).toEqual([
      '성명=',
      '날짜=11월 7일',
    ]);
  });

  it('빈 글자로 바꾸면 범위를 지운다', () => {
    const editor = mixedEditor();
    editor.edit(replace(editor, 'b1', '', { start: 2, end: 4 }), editor.depth);
    expect(blockText(editor, 0)).toBe('가나마바');
  });

  it.each([
    ['줄바꿈이 든 글자', 'b1', '가\n나', {}, '바꿀 글자에 줄바꿈이 있습니다. 새 문단은 insert_paragraph 로 넣으세요.'],
    ['빈 범위에 빈 글자', 'b1', '', { start: 2, end: 2 }, 'b1: 바꿀 것이 없습니다(빈 범위에 빈 글자). 지우려면 범위를, 넣으려면 글자를 주세요.'],
    [
      '블록 글자 밖 범위',
      'b1',
      'X',
      { start: 3, end: 9 },
      'b1: 글자 범위가 맞지 않습니다(start 3, end 9, 글자 수 5). 0 ≤ start ≤ end ≤ 글자 수로 주세요.',
    ],
    ['문단에 cell', 'b1', 'X', { cell: { row: 0, col: 0 } }, 'b1: 표 블록이 아니라 cell 을 줄 수 없습니다.'],
    ['표인데 cell 없음', 'b12', 'X', {}, 'b12: 표 블록은 cell 로 바꿀 칸을 고르세요.'],
    [
      '표에 없는 칸',
      'b12',
      'X',
      { cell: { row: 5, col: 0 } },
      'b12: 표에 없는 칸입니다(row 5, col 0). 이 표는 3행 3열이고, 합친 칸은 왼쪽 위 칸 좌표로 고릅니다(read_blocks 의 cells).',
    ],
  ])('%s 이면 이유를 던지고 문서는 그대로다', (_case, id, text, extra, message) => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    const before = JSON.stringify(editor.blocks);

    expect(() => editor.edit(replace(editor, id, text, extra), editor.depth)).toThrow(message);
    expect(JSON.stringify(editor.blocks)).toBe(before);
    expect(editor.undo(1, editor.depth)).toBe(0);
  });

  it('뷰어 문서에 없는 블록 위치면 get_outline 을 다시 부르라고 한다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    const operation: EditOperation = {
      kind: 'replace_text',
      targets: [{ id: 'b99', anchor: { section: 0, paragraph: 99, part: 'text' } }],
      text: 'X',
    };
    expect(() => editor.edit(operation, editor.depth)).toThrow('b99: 뷰어 문서에 이 블록이 없습니다. get_outline 을 다시 부르세요.');
  });

  it('편집하다 중간에 실패하면(글자를 넣은 뒤 지우기에서 rhwp 오류) 스냅샷으로 되돌려 문서는 그대로다', () => {
    const editor = mixedEditor();
    const before = JSON.stringify(editor.blocks);
    const { doc } = editor;
    // 첫 글자 뒤에 새 글자를 넣은 다음 단계(옛 글자 지우기)에서 던지게 한다
    doc.deleteText = () => {
      throw new Error('rhwp 오류');
    };

    expect(() => editor.edit(replace(editor, 'b1', 'XYZ', { start: 2, end: 4 }), editor.depth)).toThrow('rhwp 오류');
    expect(doc.getTextRange(S, 0, 0, doc.getParagraphLength(S, 0))).toBe('가나다라마바');
    expect(JSON.stringify(editor.blocks)).toBe(before);
    expect(editor.undo(1, editor.depth)).toBe(0);
  });
});

describe('SPEC-005 replace_text 여러 자리 (편집 공용 경로)', () => {
  it('AC-4 같은 블록 안 여러 자리를 편집 전 위치 기준으로 바꾼다(앞 자리 길이가 달라져도, 준 순서와 상관없이)', () => {
    const editor = mixedEditor();

    editor.edit(replaceMany(editor, [{ id: 'b1', start: 4, end: 5 }, { id: 'b1', start: 0, end: 1 }], '가가가'), editor.depth);

    expect(blockText(editor, 0)).toBe('가가가나다라가가가바');
  });

  it('AC-4 여러 블록·같은 칸 여러 자리를 한 편집으로 바꾸고, undo 한 번에 모두 돌아간다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    const before = JSON.stringify(editor.blocks);
    // b11 "회신 기한: … 인원을 회신하여 …" 의 두 "회신", b12 (1,1) 칸 "11. 20.(목) 14:00" 의 두 "1"
    const operation = replaceMany(
      editor,
      [
        { id: 'b11', start: 0, end: 2 },
        { id: 'b11', start: 33, end: 35 },
        { id: 'b12', cell: { row: 1, col: 1 }, start: 0, end: 1 },
        { id: 'b12', cell: { row: 1, col: 1 }, start: 11, end: 12 },
      ],
      '답장',
    );

    const changed = editor.edit(operation, editor.depth).changed;

    expect(blockText(editor, 10)).toBe('답장 기한: 2026. 11. 14.(금)까지 참석 인원을 답장하여 주시기 바랍니다.');
    const table = editor.blocks[11];
    expect(table?.kind === 'table' ? table.cells.find((c) => c.row === 1 && c.col === 1)?.text : undefined).toBe('답장1. 20.(목) 답장4:00');
    expect(changed.map(({ block }) => block.kind)).toEqual(['paragraph', 'table']);

    expect(editor.undo(1, editor.depth)).toBe(1);
    expect(JSON.stringify(editor.blocks)).toBe(before);
  });

  it('AC-4 같은 누름틀 값 안 여러 자리도 편집 전 위치 기준이다', () => {
    const editor = new DocumentEditor(openFixture('application.hwpx'));
    // b7 = 신청인 누름틀
    editor.edit(replace(editor, 'b7', '가나다'), editor.depth);

    editor.edit(replaceMany(editor, [{ id: 'b7', start: 0, end: 1 }, { id: 'b7', start: 1, end: 2 }], 'XX'), editor.depth);

    expect(blockText(editor, 6)).toBe('XXXX다');
  });

  it.each([
    ['범위가 겹치면', [{ id: 'b1', start: 0, end: 3 }, { id: 'b1', start: 2, end: 4 }], '바꿀 자리가 겹칩니다: b1 2~4'],
    ['같은 자리에 두 번 넣으면', [{ id: 'b1', start: 2, end: 2 }, { id: 'b1', start: 2, end: 2 }], '바꿀 자리가 겹칩니다: b1 2~2'],
    ['블록 전체와 그 안 자리를 같이 주면', [{ id: 'b1' }, { id: 'b1', start: 1, end: 2 }], '바꿀 자리가 겹칩니다: b1 1~2'],
    [
      '한 자리라도 범위 밖이면',
      [{ id: 'b1', start: 0, end: 1 }, { id: 'b1', start: 3, end: 9 }],
      'b1: 글자 범위가 맞지 않습니다(start 3, end 9, 글자 수 6). 0 ≤ start ≤ end ≤ 글자 수로 주세요.',
    ],
    ['한 자리라도 문단에 cell 을 주면', [{ id: 'b1', start: 0, end: 1 }, { id: 'b1', cell: { row: 0, col: 0 } }], 'b1: 표 블록이 아니라 cell 을 줄 수 없습니다.'],
  ])('AC-5 %s 아무것도 바꾸지 않고 이유를 던진다', (_case, spots, message) => {
    const editor = mixedEditor();
    const before = JSON.stringify(editor.blocks);

    expect(() => editor.edit(replaceMany(editor, spots, 'X'), editor.depth)).toThrow(message);
    expect(blockText(editor, 0)).toBe('가나다라마바');
    expect(JSON.stringify(editor.blocks)).toBe(before);
    expect(editor.undo(1, editor.depth)).toBe(0);
  });

  it('AC-5 표의 다른 칸 같은 위치는 겹치지 않는다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    editor.edit(
      replaceMany(
        editor,
        [
          { id: 'b12', cell: { row: 1, col: 0 }, start: 0, end: 0 },
          { id: 'b12', cell: { row: 1, col: 1 }, start: 0, end: 0 },
        ],
        '*',
      ),
      editor.depth,
    );
    const table = editor.blocks[11];
    const cellText = (row: number, col: number) => (table?.kind === 'table' ? table.cells.find((c) => c.row === row && c.col === col)?.text : undefined);
    expect([cellText(1, 0)?.[0], cellText(1, 1)?.[0]]).toEqual(['*', '*']);
  });

  it('AC-5 한 자리라도 뷰어 문서에 없는 블록이면 아무것도 바꾸지 않는다', () => {
    const editor = mixedEditor();
    const operation: EditOperation = {
      kind: 'replace_text',
      targets: [targetOf(editor, 'b1', { start: 0, end: 1 }), { id: 'b99', anchor: { section: 0, paragraph: 99, part: 'text' } }],
      text: 'X',
    };

    expect(() => editor.edit(operation, editor.depth)).toThrow('b99: 뷰어 문서에 이 블록이 없습니다. get_outline 을 다시 부르세요.');
    expect(blockText(editor, 0)).toBe('가나다라마바');
  });

  it('AC-6 자리마다 그 자리 첫 글자 모양을 따른다(굵은 자리와 보통 자리가 섞인 문단)', () => {
    const editor = mixedEditor();
    const boldId = charShapeIdAt(editor.doc, 0, 2);
    const normalId = charShapeIdAt(editor.doc, 0, 0);

    editor.edit(replaceMany(editor, [{ id: 'b1', start: 0, end: 1 }, { id: 'b1', start: 2, end: 3 }], 'XY'), editor.depth);

    expect(blockText(editor, 0)).toBe('XY나XY라마바');
    expect([0, 1, 2, 3, 4, 5].map((offset) => charShapeIdAt(editor.doc, 0, offset))).toEqual([
      normalId,
      normalId,
      normalId,
      boldId,
      boldId,
      boldId,
    ]);
  });

  it(`AC-8 한 번에 ${MAX_REPLACE_TARGETS} 곳까지 바꾸고, 넘으면 이유를 던지고 바꾸지 않는다`, () => {
    const doc = createBlankDocument();
    doc.insertText(S, 0, 0, '가'.repeat(MAX_REPLACE_TARGETS + 1));
    const editor = new DocumentEditor(doc);
    const spots = (count: number) => Array.from({ length: count }, (_, i) => ({ id: 'b1', start: i, end: i + 1 }));

    expect(() => editor.edit(replaceMany(editor, spots(MAX_REPLACE_TARGETS + 1), '나'), editor.depth)).toThrow(
      `바꿀 자리가 ${MAX_REPLACE_TARGETS + 1} 곳이라 너무 많습니다(${MAX_REPLACE_TARGETS} 까지).`,
    );
    expect(blockText(editor, 0)).toBe('가'.repeat(MAX_REPLACE_TARGETS + 1));

    editor.edit(replaceMany(editor, spots(MAX_REPLACE_TARGETS), '나'), editor.depth);
    expect(blockText(editor, 0)).toBe(`${'나'.repeat(MAX_REPLACE_TARGETS)}가`);
  });
});

describe('SPEC-005 문단 자리와 누름틀 값 (PR #67 리뷰)', () => {
  /** application.hwpx 의 신청인 누름틀(b7, 문단 5)에 "홍길동" 을 채운 편집기. b6 문단 글자는 "신청인  홍길동"(누름틀 값 5~8) */
  function filledEditor(): DocumentEditor {
    const doc = openFixture('application.hwpx');
    const applicant = listFields(doc).find((field) => field.name === '신청인');
    if (applicant === undefined) throw new Error('신청인 누름틀이 없다');
    doc.setFieldValue(applicant.fieldId, '홍길동');
    return new DocumentEditor(doc);
  }

  it.each([
    ['문단 범위가 누름틀 값 앞에서 값 안으로 걸치면', [{ id: 'b6', start: 4, end: 7 }], 'b6 4~7 (누름틀 "신청인" 값 5~8)'],
    ['문단 범위가 누름틀 값을 덮으면', [{ id: 'b6', start: 5, end: 8 }], 'b6 5~8 (누름틀 "신청인" 값 5~8)'],
    ['문단 전체를 바꾸면(누름틀 값이 든 문단)', [{ id: 'b6' }], 'b6 0~8 (누름틀 "신청인" 값 5~8)'],
    ['누름틀 값 안에 문단 위치로 넣으면', [{ id: 'b6', start: 6, end: 6 }], 'b6 6~6 (누름틀 "신청인" 값 5~8)'],
    ['여러 자리 중 하나라도 걸치면', [{ id: 'b6', start: 0, end: 1 }, { id: 'b6', start: 7, end: 8 }], 'b6 7~8 (누름틀 "신청인" 값 5~8)'],
  ])('%s 아무것도 바꾸지 않고 누름틀 블록으로 바꾸라고 한다', (_case, spots, where) => {
    const editor = filledEditor();
    const before = JSON.stringify(editor.blocks);

    expect(() => editor.edit(replaceMany(editor, spots, 'X'), editor.depth)).toThrow(
      `바꿀 자리가 누름틀 값에 걸칩니다: ${where}. 누름틀 값은 그 누름틀 블록(get_outline 의 kind field) id 로 바꾸세요.`,
    );
    expect(JSON.stringify(editor.blocks)).toBe(before);
    expect(editor.undo(1, editor.depth)).toBe(0);
  });

  it('표 칸 범위가 칸 안 누름틀 값에 걸쳐도 아무것도 바꾸지 않는다', () => {
    const doc = openFixture('notice.hwpx');
    // b12 표 (1,1) 칸(칸 번호 4) "11. 20.(목) 14:00" 첫 자리에 누름틀을 넣고 "XY" 를 채운다 → 칸 글자 "XY11. 20.(목) 14:00"
    doc.insertClickHereFieldInCell(S, 11, 0, 4, 0, 0, false, '입력', '', '칸 누름틀', true);
    const cellField = listFields(doc).find((field) => field.name === '칸 누름틀');
    if (cellField === undefined) throw new Error('칸 누름틀이 없다');
    doc.setFieldValue(cellField.fieldId, 'XY');
    const editor = new DocumentEditor(doc);
    const before = JSON.stringify(editor.blocks);

    expect(() => editor.edit(replace(editor, 'b12', '-', { cell: { row: 1, col: 1 }, start: 1, end: 4 }), editor.depth)).toThrow(
      '바꿀 자리가 누름틀 값에 걸칩니다: b12 칸(1,1) 1~4 (누름틀 "칸 누름틀" 값 0~2). 누름틀 값은 그 누름틀 블록(get_outline 의 kind field) id 로 바꾸세요.',
    );
    expect(JSON.stringify(editor.blocks)).toBe(before);

    // 다른 칸(1,0) 같은 위치는 걸치지 않는다
    editor.edit(replace(editor, 'b12', '-', { cell: { row: 1, col: 0 }, start: 1, end: 2 }), editor.depth);
    expect(editor.depth).toBe(1);
  });

  it('누름틀 값 바로 앞·뒤에 문단 위치로 넣는 것은 값에 걸치지 않는다', () => {
    const editor = filledEditor();

    editor.edit(replaceMany(editor, [{ id: 'b6', start: 5, end: 5 }, { id: 'b6', start: 8, end: 8 }], '*'), editor.depth);

    expect([blockText(editor, 5), blockText(editor, 6)]).toEqual(['신청인  *홍길동*', '홍길동']);
  });

  it('같은 문단의 문단 글자 자리와 그 누름틀 값 자리를 함께 주면 둘 다 편집 전 위치로 바뀐다', () => {
    const editor = filledEditor();

    // 문단 0~3 "신청인" 을 먼저 바꿔 누름틀이 밀려도, 누름틀 값 자리 0~1 "홍" 은 값 안 위치라 그대로 맞는다
    editor.edit(replaceMany(editor, [{ id: 'b7', start: 0, end: 1 }, { id: 'b6', start: 0, end: 3 }], 'AB'), editor.depth);

    expect([blockText(editor, 5), blockText(editor, 6)]).toEqual(['AB  AB길동', 'AB길동']);
  });

  it('앞 자리를 이미 바꾼 뒤 뒤 자리 적용이 실패하면 모든 자리가 되돌아간다', () => {
    const editor = mixedEditor();
    const before = JSON.stringify(editor.blocks);
    const { doc } = editor;
    // 검사는 모두 통과하는 자리 둘. 뒤 자리(4~5)부터 바꾸므로, 두 번째 글자 넣기(앞 자리 0~1)에서 rhwp 가 던지게 한다
    const insertText = doc.insertText.bind(doc);
    let inserts = 0;
    doc.insertText = (section, paragraph, offset, text) => {
      inserts += 1;
      if (inserts === 2) throw new Error('rhwp 오류');
      return insertText(section, paragraph, offset, text);
    };

    expect(() => editor.edit(replaceMany(editor, [{ id: 'b1', start: 0, end: 1 }, { id: 'b1', start: 4, end: 5 }], 'XY'), editor.depth)).toThrow(
      'rhwp 오류',
    );
    expect(inserts).toBe(2);
    expect(doc.getTextRange(S, 0, 0, doc.getParagraphLength(S, 0))).toBe('가나다라마바');
    expect(JSON.stringify(editor.blocks)).toBe(before);
    expect(editor.undo(1, editor.depth)).toBe(0);
  });
});

describe('SPEC-002 되돌리기 (편집 공용 경로)', () => {
  it('AC-8 편집을 하나씩 되돌리고, 되돌릴 것이 없으면 0 을 돌려준다', () => {
    const editor = mixedEditor();
    editor.edit(replace(editor, 'b1', '하', { start: 0, end: 1 }), editor.depth);
    editor.edit(replace(editor, 'b1', '호', { start: 5, end: 6 }), editor.depth);
    expect(blockText(editor, 0)).toBe('하나다라마호');

    expect(editor.undo(1, editor.depth)).toBe(1);
    expect(blockText(editor, 0)).toBe('하나다라마바');
    expect(editor.undo(1, editor.depth)).toBe(1);
    expect(blockText(editor, 0)).toBe('가나다라마바');
    expect(editor.undo(1, editor.depth)).toBe(0);
  });

  it(`AC-8 ${UNDO_LIMIT}단계까지만 되돌리고, 그보다 옛 편집은 남는다`, () => {
    const editor = mixedEditor();
    for (let i = 0; i <= UNDO_LIMIT; i += 1) editor.edit(replace(editor, 'b1', String(i % 10), { start: 0, end: 1 }), editor.depth);

    expect(editor.undo(UNDO_LIMIT + 5, editor.depth)).toBe(UNDO_LIMIT);
    // 첫 편집("0")은 되돌릴 수 없다
    expect(blockText(editor, 0)).toBe('0나다라마바');
  });

  it('AC-12 문서를 닫을 때 버린 편집 수를 돌려준다', () => {
    const editor = mixedEditor();
    editor.edit(replace(editor, 'b1', 'X', { start: 0, end: 1 }), editor.depth);
    editor.edit(replace(editor, 'b1', 'Y', { start: 0, end: 1 }), editor.depth);
    expect(editor.dispose()).toBe(2);
  });
});

describe('SPEC-002 편집 기록 맞추기 (PR #26 리뷰)', () => {
  it('바뀐 블록을 보여 주다(다시 그리기 등) 던지면 스냅샷으로 되돌리고 편집 기록에 넣지 않는다', () => {
    const editor = mixedEditor();
    const before = JSON.stringify(editor.blocks);

    expect(() =>
      editor.edit(replace(editor, 'b1', 'XYZ', { start: 2, end: 4 }), editor.depth, () => {
        throw new Error('다시 그리기 실패');
      }),
    ).toThrow('다시 그리기 실패');

    expect(blockText(editor, 0)).toBe('가나다라마바');
    expect(JSON.stringify(editor.blocks)).toBe(before);
    expect(editor.depth).toBe(0);
    expect(editor.undo(1, 0)).toBe(0);
  });

  it('서버가 아는 편집 순번이 뷰어 기록과 다르면 편집·되돌리기를 하지 않고 어긋났다고 알린다', () => {
    const editor = mixedEditor();
    editor.edit(replace(editor, 'b1', 'X', { start: 0, end: 1 }), 0);
    expect(editor.depth).toBe(1);

    // 서버는 첫 편집 결과를 받지 못해(타임아웃 등) 아직 0 이라고 안다
    expect(() => editor.edit(replace(editor, 'b1', 'Y', { start: 0, end: 1 }), 0)).toThrow(
      '편집 기록이 어긋났습니다(서버 0, 뷰어 1). open_document 로 문서를 다시 열어 주세요.',
    );
    expect(() => editor.undo(1, 0)).toThrow('편집 기록이 어긋났습니다(서버 0, 뷰어 1)');
    expect(blockText(editor, 0)).toBe('X나다라마바');
    expect(editor.undo(1, 1)).toBe(1);
    expect(editor.depth).toBe(0);
  });
});

describe('SPEC-002 바뀐 블록 (PR #26 리뷰)', () => {
  it('편집으로 글자를 모두 지운 문단은 빈 블록으로 남아 다시 채울 수 있다(처음 열 때 빈 문단은 빼는 규칙은 그대로)', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    const count = editor.blocks.length;

    const emptied = editor.edit(replace(editor, 'b5', ''), editor.depth).changed;

    expect(emptied.map(({ block }) => textOf(block))).toEqual(['']);
    expect(editor.blocks).toHaveLength(count);
    editor.edit(replace(editor, 'b5', '제목  다시 쓴 제목'), editor.depth);
    expect(blockText(editor, 4)).toBe('제목  다시 쓴 제목');
    // 처음부터 비어 있던 문단(4번 등)은 여전히 블록이 아니다
    expect(new DocumentEditor(openFixture('notice.hwpx')).blocks.some((b) => b.kind === 'paragraph' && b.paragraph === 4)).toBe(false);
  });

  it('누름틀 값을 바꾸면 같은 문단의 문단 블록도 바뀐 블록으로 알린다', () => {
    const editor = new DocumentEditor(openFixture('application.hwpx'));

    const changed = editor.edit(replace(editor, 'b7', '홍길동'), editor.depth).changed;

    expect(changed.map(({ block }) => `${block.kind}:${textOf(block)}`)).toEqual(['paragraph:신청인  홍길동', 'field:홍길동']);
  });

  it('누름틀이 든 문단의 글자를 바꾸면 그 누름틀 블록도 바뀐 블록으로 알린다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));

    const changed = editor.edit(replace(editor, 'b2', '받는 곳', { start: 0, end: 2 }), editor.depth).changed;

    expect(changed.map(({ block }) => block.kind)).toEqual(['paragraph', 'field']);
  });
});

describe('SPEC-002 바뀐 블록 표시 자리', () => {
  it('AC-7 바뀐 블록마다 블록 전체(문단 줄·표)를 감싸는 사각형을 쪽마다 하나 준다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    const paragraph = editor.edit(replace(editor, 'b7', '짧은 문장'), editor.depth).changed;
    const table = editor.edit(replace(editor, 'b12', '3회차', { cell: { row: 2, col: 0 } }), editor.depth).changed;

    const [paragraphBox] = blockBoxes(editor.doc, editor.blocks, paragraph.map(({ anchor }) => anchor)).boxes;
    const tableBoxes = blockBoxes(editor.doc, editor.blocks, table.map(({ anchor }) => anchor)).boxes;

    expect(paragraphBox?.width).toBeGreaterThan(0);
    expect(tableBoxes).toHaveLength(1);
    expect(tableBoxes[0]?.height).toBeGreaterThan(paragraphBox?.height ?? 0);
  });

  it('글자를 모두 지운 빈 문단은 표시할 자리가 없어 건너뛰고 표시하지 못한 블록으로 알린다', () => {
    const editor = mixedEditor();
    const changed = editor.edit(replace(editor, 'b1', ''), editor.depth).changed;
    expect(blockBoxes(editor.doc, editor.blocks, changed.map(({ anchor }) => anchor))).toEqual({
      boxes: [],
      unmarked: [{ section: 0, paragraph: 0, part: 'text' }],
    });
  });
});

/** 블록 id(문서를 연 때 순서)로 기준·대상 블록을 만든다 */
const blockRef = (editor: DocumentEditor, id: string) => {
  const { anchor } = targetOf(editor, id);
  return { id, anchor };
};
const insert = (editor: DocumentEditor, id: string, where: 'before' | 'after', text: string): EditOperation => ({
  kind: 'insert_paragraph',
  reference: blockRef(editor, id),
  where,
  text,
});
const remove = (editor: DocumentEditor, ...ids: string[]): EditOperation => ({
  kind: 'delete_blocks',
  targets: ids.map((id) => blockRef(editor, id)),
});
/** 블록을 "종류:글자" 로 */
const describeBlocks = (editor: DocumentEditor) => editor.blocks.map((block) => `${block.kind}:${textOf(block)}`);
const paraShapeIdAt = (doc: HwpDocument, paragraph: number): unknown => JSON.parse(doc.getParaPropertiesAt(S, paragraph)).paraShapeId;
/** 1×1 투명 PNG */
const ONE_PIXEL_PNG = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);
/** 문단에 든 표의 컨트롤 번호 */
const tableControlAt = (doc: HwpDocument, paragraph: number): number => {
  const controls: unknown = JSON.parse(doc.getControls());
  const table = z
    .array(z.object({ ctrlId: z.string(), para: z.number(), controlIndex: z.number() }))
    .parse(controls)
    .find((control) => control.ctrlId === 'tbl' && control.para === paragraph);
  if (table === undefined) throw new Error('표가 없다');
  return table.controlIndex;
};
const tableId = (editor: DocumentEditor) => {
  const id = BlockIdTable.assign(editor.blocks)
    .label(editor.blocks)
    .find(({ block }) => block.kind === 'table')?.id;
  if (id === undefined) throw new Error('표가 없다');
  return id;
};

describe('SPEC-002 insert_paragraph (편집 공용 경로)', () => {
  it('AC-2 기준 문단 뒤에 넣으면 기준 문단 모양·마지막 글자 모양을 따르고, 넣은 문단을 바뀐 블록으로 돌려준다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    const reference = 10; // b11 "회신 기한: …"
    const last = editor.doc.getParagraphLength(S, reference) - 1;

    const { changed, changes } = editor.edit(insert(editor, 'b11', 'after', '문의: 안전총괄과'), editor.depth);

    expect(changes).toEqual({ deletedTables: [], deletedParagraphs: [], inserted: [{ section: S, paragraph: 11, parts: ['text'] }] });
    expect(changed).toEqual([
      {
        anchor: { section: S, paragraph: 11, part: 'text' },
        block: expect.objectContaining({ kind: 'paragraph', text: '문의: 안전총괄과' }),
      },
    ]);
    expect(paraShapeIdAt(editor.doc, 11)).toBe(paraShapeIdAt(editor.doc, reference));
    expect(charShapeIdAt(editor.doc, 11, 0)).toBe(charShapeIdAt(editor.doc, reference, last));
    // 뒤 블록(표)은 한 문단 밀린다
    expect(editor.blocks.find((block) => block.kind === 'table')?.paragraph).toBe(12);
  });

  it('AC-2 번호 문단 앞에 넣으면 새 문단도 번호를 받고 뒤 번호가 다시 매겨진다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    const numberOf = (text: string) => {
      const block = editor.blocks.find((b) => b.kind === 'paragraph' && b.text.startsWith(text));
      return block?.kind === 'paragraph' ? block.number : undefined;
    };
    expect(numberOf('관련')).toBe('1.');

    editor.edit(insert(editor, 'b6', 'before', '새로 넣은 항목'), editor.depth);

    expect([numberOf('새로 넣은 항목'), numberOf('관련')]).toEqual(['1.', '2.']);
  });

  it('AC-2 기준이 표·누름틀이면 그것이 든 문단 앞뒤에 넣는다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    editor.edit(insert(editor, 'b12', 'before', '표 앞 문단'), editor.depth);
    editor.edit(insert(editor, 'b3', 'after', '수신 뒤 문단'), editor.depth);

    const texts = describeBlocks(editor);
    expect(texts.slice(0, 4)).toEqual(['paragraph:가나다구청', 'paragraph:수신  ', 'field:', 'paragraph:수신 뒤 문단']);
    expect(texts.indexOf('paragraph:표 앞 문단') + 1).toBe(texts.findIndex((text) => text.startsWith('table:')));
  });

  it('AC-2 빈 글자면 빈 문단을 넣고 빈 문단 블록으로 남겨 다시 채울 수 있다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    const count = editor.blocks.length;

    const changed = editor.edit(insert(editor, 'b1', 'after', ''), editor.depth).changed;

    expect(changed.map(({ block }) => textOf(block))).toEqual(['']);
    expect(editor.blocks).toHaveLength(count + 1);
    editor.edit(replace(editor, 'b2', '채운 글자'), editor.depth);
    expect(blockText(editor, 1)).toBe('채운 글자');
  });

  it('줄바꿈이 든 글자와 구역 첫 문단 앞에는 넣지 않고 문서는 그대로다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    const before = JSON.stringify(editor.blocks);

    expect(() => editor.edit(insert(editor, 'b5', 'after', '첫 줄\n둘째 줄'), editor.depth)).toThrow(
      '넣을 글자에 줄바꿈이 있습니다. 문단을 여럿 넣으려면 insert_paragraph 를 문단마다 부르세요.',
    );
    expect(() => editor.edit(insert(editor, 'b1', 'before', '맨 앞'), editor.depth)).toThrow(
      '구역 첫 문단 앞에는 문단을 넣을 수 없습니다. 첫 문단 뒤에 넣으세요.',
    );
    expect(JSON.stringify(editor.blocks)).toBe(before);
    expect(editor.depth).toBe(0);
  });

  it('AC-2 넣기를 되돌리면 넣은 문단이 사라지고 블록이 넣기 전과 같다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    const before = JSON.stringify(editor.blocks);
    editor.edit(insert(editor, 'b7', 'after', '넣은 문단'), editor.depth);

    expect(editor.undo(1, editor.depth)).toBe(1);
    expect(JSON.stringify(editor.blocks)).toBe(before);
  });
});

/** "첫 문단 / 지울 문단 / 글상자 문단(글상자 안 '링크 글자' 의 '링크' 에 하이퍼링크)" 문서 (#42) */
function textboxLinkDocument(): HwpDocument {
  const doc = createBlankDocument();
  doc.insertText(S, 0, 0, '첫 문단');
  doc.splitParagraph(S, 0, 4);
  doc.insertText(S, 1, 0, '지울 문단');
  doc.splitParagraph(S, 1, 5);
  doc.insertText(S, 2, 0, '글상자 문단');
  doc.createShapeControl(
    JSON.stringify({ sectionIdx: S, paraIdx: 2, charOffset: 0, width: 20000, height: 4000, horzOffset: 0, vertOffset: 0, treatAsChar: true, textWrap: 'Square' }),
  );
  doc.setTextBoxAt(2, 0, true);
  doc.insertTextInCell(S, 2, 0, 0, 0, 0, '링크 글자');
  doc.insertHyperlinkEx(JSON.stringify({ target: { section: S, para: 2, cellPath: [[0, 0, 0]] }, uri: 'https://example.com', start: 0, end: 2 }));
  return doc;
}

describe('SPEC-002 delete_blocks (편집 공용 경로)', () => {
  it('AC-3 여러 문단을 한 편집으로 지우고, 한 번 되돌리면 모두 돌아온다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    const before = JSON.stringify(editor.blocks);
    const all = describeBlocks(editor);

    const { changed, changes } = editor.edit(remove(editor, 'b8', 'b10'), editor.depth);

    // 지운 문단은 바뀐 블록이 아니다. "나." 가 "가." 로 다시 매겨진 문단만 바뀐 블록이다(#21 번호가 바뀐 문단)
    expect(changed.map(({ block }) => (block.kind === 'paragraph' ? `${block.number} ${block.text.slice(0, 5)}` : block.kind))).toEqual([
      '가. 교육 내용',
    ]);
    expect(changes).toEqual({
      deletedTables: [],
      deletedParagraphs: [
        { section: S, paragraph: 7 },
        { section: S, paragraph: 9 },
      ],
      inserted: [],
    });
    expect(describeBlocks(editor)).toEqual(all.filter((_, i) => i !== 7 && i !== 9));
    expect(editor.doc.getParagraphCount(S)).toBe(13);
    expect(editor.undo(1, editor.depth)).toBe(1);
    expect(JSON.stringify(editor.blocks)).toBe(before);
  });

  it('AC-3 표만 든 문단의 표를 지우면 문단째 지워 빈 줄이 남지 않는다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));

    const { changes } = editor.edit(remove(editor, 'b12'), editor.depth);

    expect(changes?.deletedParagraphs).toEqual([{ section: S, paragraph: 11 }]);
    expect(editor.blocks.some((block) => block.kind === 'table')).toBe(false);
    expect(editor.doc.getParagraphCount(S)).toBe(14);
  });

  it('AC-3 표가 든 문단에 글자도 있으면 표만 지우고 글자는 남긴다', () => {
    const doc = openFixture('notice.hwpx');
    doc.insertText(S, 11, doc.getParagraphLength(S, 11), '표 아래 설명');
    const editor = new DocumentEditor(doc);

    const { changes } = editor.edit(remove(editor, tableId(editor)), editor.depth);

    expect(changes).toEqual({ deletedTables: [{ section: S, paragraph: 11, controlIndex: 0 }], deletedParagraphs: [], inserted: [] });
    expect(editor.blocks.some((block) => block.kind === 'table')).toBe(false);
    expect(describeBlocks(editor)).toContain('paragraph:표 아래 설명');
    expect(editor.doc.getParagraphCount(S)).toBe(15);
  });

  it('AC-3 누름틀이 든 문단 블록을 지우면 누름틀도 같이 지워진다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));

    editor.edit(remove(editor, 'b2'), editor.depth);

    expect(editor.blocks.some((block) => block.kind === 'field')).toBe(false);
    expect(listFields(editor.doc)).toEqual([]);
  });

  it('AC-3 누름틀 블록과 구역 첫 문단은 지우지 않고 문서는 그대로다(구역을 비우는 삭제도 첫 문단에서 막힌다)', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    const before = JSON.stringify(editor.blocks);
    const everything = BlockIdTable.assign(editor.blocks)
      .label(editor.blocks)
      .flatMap(({ id, block }) => (id === undefined || block.kind === 'field' ? [] : [id]));

    expect(() => editor.edit(remove(editor, 'b3'), editor.depth)).toThrow(
      '누름틀 블록은 지울 수 없습니다: b3. 값을 비우려면 replace_text 를, 문단째 지우려면 그 문단 블록 id 를 주세요.',
    );
    expect(() => editor.edit(remove(editor, ...everything), editor.depth)).toThrow(
      '구역 첫 문단은 지울 수 없습니다(구역·단 정의가 든 문단): b1. 글자를 지우려면 replace_text 를 쓰세요.',
    );
    expect(JSON.stringify(editor.blocks)).toBe(before);
    expect(editor.depth).toBe(0);
  });

  it('표만 든 문단에 블록이 아닌 개체(수식 등)가 같이 있으면 지우지 않는다', () => {
    const doc = openFixture('notice.hwpx');
    doc.insertEquation(S, 11, 0, 'x+y', 1000, 0);
    const editor = new DocumentEditor(doc);
    const before = JSON.stringify(editor.blocks);
    const table = tableId(editor);

    expect(() => editor.edit(remove(editor, table), editor.depth)).toThrow(
      `${table}: 문단에 블록이 아닌 개체(수식)가 있어 같이 사라지므로 지울 수 없습니다.`,
    );
    expect(JSON.stringify(editor.blocks)).toBe(before);
  });

  it('누름틀이 든 표는 표만 지우지 않고, 표만 든 문단이면 문단째 지운다', () => {
    const withText = openFixture('notice.hwpx');
    withText.insertClickHereFieldInCell(S, 11, 0, 0, 0, 0, false, '입력', '', '칸 누름틀', true);
    withText.insertText(S, 11, withText.getParagraphLength(S, 11), '표 아래 설명');
    const editor = new DocumentEditor(withText);
    const table = tableId(editor);
    expect(() => editor.edit(remove(editor, table), editor.depth)).toThrow(
      `${table}: 누름틀이 든 문단에서는 표만 지울 수 없습니다(표만 지우면 누름틀이 망가집니다). 문단째 지우려면 표가 든 문단의 문단 블록 id 를 같이 주세요.`,
    );

    const alone = openFixture('notice.hwpx');
    alone.insertClickHereFieldInCell(S, 11, 0, 0, 0, 0, false, '입력', '', '칸 누름틀', true);
    const aloneEditor = new DocumentEditor(alone);
    expect(aloneEditor.blocks.filter((block) => block.paragraph === 11).map((block) => block.kind)).toEqual(['table', 'field']);
    aloneEditor.edit(remove(aloneEditor, tableId(aloneEditor)), aloneEditor.depth);
    expect(aloneEditor.blocks.some((block) => block.kind === 'table' || (block.kind === 'field' && block.name === '칸 누름틀'))).toBe(false);
  });

  it('AC-3 글자가 있는 문단도 블록이 아닌 개체(각주·그림 등)가 있으면 지우지 않고 이유를 알린다 (PR #29 리뷰)', () => {
    const doc = openFixture('notice.hwpx');
    doc.insertFootnote(S, 5, 1); // b6 "관련: …"
    doc.insertPicture(S, 6, 0, '', ONE_PIXEL_PNG, 1000, 1000, 1, 1, 'png', '그림'); // b7
    const editor = new DocumentEditor(doc);
    const before = JSON.stringify(editor.blocks);

    expect(() => editor.edit(remove(editor, 'b6'), editor.depth)).toThrow('b6: 문단에 블록이 아닌 개체(각주)가 있어 같이 사라지므로 지울 수 없습니다.');
    expect(() => editor.edit(remove(editor, 'b7'), editor.depth)).toThrow('b7: 문단에 블록이 아닌 개체(그림)가 있어 같이 사라지므로 지울 수 없습니다.');
    expect(JSON.stringify(editor.blocks)).toBe(before);
  });

  it('책갈피·새 번호 같은 보이지 않는 인라인 컨트롤은 지우기를 막지 않는다 (PR #29 리뷰)', () => {
    const doc = openFixture('notice.hwpx');
    doc.addBookmark(S, 11, 0, '표 책갈피'); // 표만 든 문단
    doc.addBookmark(S, 7, 1, '문단 책갈피'); // b8
    const editor = new DocumentEditor(doc);

    editor.edit(remove(editor, tableId(editor), 'b8'), editor.depth);

    expect(editor.blocks.some((block) => block.kind === 'table')).toBe(false);
    expect(editor.doc.getParagraphCount(S)).toBe(13);
  });

  it('표만 든 문단에 표 밖 누름틀이 있으면 표 안 누름틀로 보지 않아 문단째 지우지 않고, 표만 지울 수도 없다고 알린다 (PR #29 리뷰)', () => {
    const doc = openFixture('notice.hwpx');
    doc.insertClickHereField(S, 11, doc.getParagraphLength(S, 11), '비고', '', '비고', true);
    const editor = new DocumentEditor(doc);
    const before = JSON.stringify(editor.blocks);
    expect(editor.blocks.filter((block) => block.paragraph === 11).map((block) => block.kind)).toEqual(['table', 'field']);
    const table = tableId(editor);

    expect(() => editor.edit(remove(editor, table), editor.depth)).toThrow(
      `${table}: 누름틀이 든 문단에서는 표만 지울 수 없습니다(표만 지우면 누름틀이 망가집니다). 표 밖에 누름틀이 있는 문단이라 문단째 지울 수도 없으므로 이 표는 지울 수 없습니다.`,
    );
    expect(JSON.stringify(editor.blocks)).toBe(before);
  });

  it('rhwp deleteTableControl 은 같은 문단의 누름틀을 잃는다 (근거)', () => {
    const doc = openFixture('notice.hwpx');
    doc.insertText(S, 11, doc.getParagraphLength(S, 11), '비고: ');
    doc.insertClickHereField(S, 11, doc.getParagraphLength(S, 11), '비고', '', '비고', true);
    expect(listFields(doc).map(({ name }) => name)).toEqual(['수신', '비고']);

    doc.deleteTableControl(S, 11, 0);

    expect(listFields(doc).map(({ name }) => name)).toEqual(['수신']);
  });

  it('구역 첫 문단에 있는 누름틀 든 표는 지울 수 없다고 분명히 알린다 (PR #29 리뷰)', () => {
    const doc = createBlankDocument();
    doc.createTable(S, 0, 0, 1, 1);
    doc.insertClickHereFieldInCell(S, 0, tableControlAt(doc, 0), 0, 0, 0, false, '입력', '', '칸 누름틀', true);
    const editor = new DocumentEditor(doc);
    const table = tableId(editor);

    expect(() => editor.edit(remove(editor, table), editor.depth)).toThrow(
      `${table}: 누름틀이 든 문단에서는 표만 지울 수 없습니다(표만 지우면 누름틀이 망가집니다). 구역 첫 문단이라 문단째 지울 수도 없으므로 이 표는 지울 수 없습니다.`,
    );
  });

  it('AC-3 글상자 안에 하이퍼링크가 있는 문서에서도 문단을 지운다. 글상자가 든 문단은 지우지 않는다 (#42)', () => {
    const doc = textboxLinkDocument();
    // rhwp 는 글상자 안 필드 위치를 칸 번호 없이 준다(실제 제안요청서와 같은 모양)
    expect(JSON.parse(doc.getFieldList())).toMatchObject([
      { fieldType: 'hyperlink', location: { sectionIndex: S, paraIndex: 2, path: [{ type: 'textbox', controlIndex: 0, paraIndex: 0 }] } },
    ]);
    const editor = new DocumentEditor(doc);
    expect(describeBlocks(editor)).toEqual(['paragraph:첫 문단', 'paragraph:지울 문단', 'paragraph:글상자 문단']);
    expect(listFields(doc)).toEqual([]);

    editor.edit(remove(editor, 'b2'), editor.depth);

    expect(describeBlocks(editor)).toEqual(['paragraph:첫 문단', 'paragraph:글상자 문단']);
    expect(() => editor.edit(remove(editor, 'b2'), editor.depth)).toThrow(
      'b2: 문단에 블록이 아닌 개체(사각형)가 있어 같이 사라지므로 지울 수 없습니다.',
    );
  });

  it('표와 글상자 안 누름틀이 든 문단: 누름틀은 표 안이 아니라 표만 지울 수 없다고 알리고, 값도 바꾸지 않는다 (#42)', () => {
    const doc = createBlankDocument();
    doc.insertText(S, 0, 0, '첫 문단');
    doc.splitParagraph(S, 0, 4);
    doc.createTable(S, 1, 0, 1, 1); // 표 = 컨트롤 0
    doc.createShapeControl(
      JSON.stringify({ sectionIdx: S, paraIdx: 1, charOffset: 1, width: 20000, height: 4000, horzOffset: 0, vertOffset: 0, treatAsChar: true, textWrap: 'Square' }),
    ); // 글상자 = 컨트롤 1
    doc.setTextBoxAt(1, 1, true);
    doc.insertClickHereFieldInCell(S, 1, 1, 0, 0, 0, true, '입력', '', '상자 누름틀', true);
    const editor = new DocumentEditor(doc);
    expect(editor.blocks.filter((block) => block.paragraph === 1).map((block) => (block.kind === 'field' ? `field:${block.inTable}` : block.kind))).toEqual([
      'table',
      'field:false',
    ]);
    const table = tableId(editor);

    expect(() => editor.edit(remove(editor, table), editor.depth)).toThrow(
      `${table}: 누름틀이 든 문단에서는 표만 지울 수 없습니다(표만 지우면 누름틀이 망가집니다). 표 밖에 누름틀이 있는 문단이라 문단째 지울 수도 없으므로 이 표는 지울 수 없습니다.`,
    );
    const [field] = listFields(doc);
    if (field === undefined) throw new Error('누름틀이 없다');
    // 값이 빈 누름틀도(setFieldValue 로 넣는 길) 거부한다
    expect(() => replaceFieldText(doc, field.fieldId, '값')).toThrow('글상자 안 누름틀 상자 누름틀 은 아직 바꿀 수 없습니다.');
    expect(listFields(doc)[0]?.value).toBe('');
  });

  it('지운 뒤에도 편집으로 비운 문단은 새 위치에서 빈 블록으로 남는다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    editor.edit(replace(editor, 'b9', ''), editor.depth);
    const count = editor.blocks.length;

    editor.edit(remove(editor, 'b7'), editor.depth);

    expect(editor.blocks).toHaveLength(count - 1);
    expect(editor.blocks.some((block) => block.kind === 'paragraph' && block.text === '' && block.paragraph === 7)).toBe(true);
  });
});

describe('SPEC-002 move_blocks (편집 공용 경로)', () => {
  it('AC-4 자동 번호 문단을 옮기면 서식째 옮겨지고 번호가 새 순서로 다시 매겨지며, 번호가 바뀐 문단도 바뀐 블록이다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    const { doc } = editor;
    const shapeOf = (paragraph: number) => paraShapeIdOf(doc, S, paragraph);
    const replyShape = shapeOf(10);
    const replyLook = charLook(doc, S, 10, 0);

    // b11 "3. 회신 기한" 을 b6 "1. 관련" 앞으로
    const { changed } = editor.edit(move(editor, ['b11'], 'b6', 'before'), editor.depth);

    expect(numbered(editor.blocks)).toEqual(['1. 회신 기한', '2. 관련: 가', '3. 하반기 주', '가. 교육 대상', '나. 교육 내용', '다. 신청 방법']);
    expect(changed.map(({ block }) => (block.kind === 'paragraph' ? `${block.number} ${block.text.slice(0, 5)}` : block.kind))).toEqual([
      '1. 회신 기한',
      '2. 관련: 가',
      '3. 하반기 주',
    ]);
    expect(shapeOf(5)).toBe(replyShape);
    expect(charLook(doc, S, 5, 0)).toBe(replyLook);
  });

  it('AC-4 이어진 개요 문단 여러 개를 하위 문단째 옮기고 상위 번호가 다시 매겨진다', () => {
    const editor = new DocumentEditor(openFixture('report.hwpx'));

    // b16 "4. 개선 과제" ~ b22(하위 문단) 를 b7 "2. 이용 현황" 앞으로
    editor.edit(move(editor, ['b16', 'b17', 'b18', 'b19', 'b20', 'b21', 'b22'], 'b7', 'before'), editor.depth);

    expect(numbered(editor.blocks).filter((n) => /^\d/.test(n))).toEqual(['1. 개요', '2. 개선 과제', '3. 이용 현황', '4. 분기별 비', '5. 향후 계획']);
  });

  it('AC-4 표가 든 문단을 옮기면 표 블록이 같이 옮겨지고 바뀐 블록으로 알린다', () => {
    const editor = new DocumentEditor(openFixture('application.hwpx'));

    const { changed } = editor.edit(move(editor, ['b2'], 'b3', 'after'), editor.depth);

    expect(editor.blocks.map((block) => block.kind)).toEqual(['paragraph', 'paragraph', 'table', 'paragraph', 'field', 'paragraph', 'field', 'paragraph']);
    expect(changed.map(({ block }) => block.kind)).toEqual(['table']);
  });

  it('AC-4 편집으로 비운 문단을 옮겨도 옮긴 자리에서 빈 문단 블록으로 남는다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    editor.edit(replace(editor, 'b5', ''), editor.depth);
    const count = editor.blocks.length;

    // 비운 b5(문단 3)를 표(b12, 문단 11) 뒤로
    editor.edit(move(editor, ['b5'], 'b12', 'after'), editor.depth);

    expect(editor.blocks).toHaveLength(count);
    expect(editor.blocks.find((block) => block.kind === 'paragraph' && block.paragraph === 11)).toMatchObject({ text: '' });
  });

  it('AC-4 비운 문단을 옮긴 뒤 되돌리면 블록 목록이 옮기기 전과 같다(엉뚱한 빈 문단 블록이 생기지 않는다) (PR #28 리뷰)', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    editor.edit(replace(editor, 'b5', ''), editor.depth);
    const before = JSON.stringify(editor.blocks);
    editor.edit(move(editor, ['b5'], 'b12', 'after'), editor.depth);

    editor.undo(1, editor.depth);

    expect(JSON.stringify(editor.blocks)).toBe(before);
  });

  it('AC-4 옮긴 편집을 되돌리면 번호와 문단이 옮기기 전으로 돌아간다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    const before = JSON.stringify(editor.blocks);
    editor.edit(move(editor, ['b11'], 'b6', 'before'), editor.depth);

    expect(editor.undo(1, editor.depth)).toBe(1);
    expect(JSON.stringify(editor.blocks)).toBe(before);
  });

  it('AC-5 옮길 수 없는 문단(각주·새 번호·책갈피)이 있으면 문단마다 이유와 블록 id 를 모아 던지고 아무것도 바꾸지 않는다', () => {
    const doc = createBlankDocument();
    doc.insertText(S, 0, 0, '첫째');
    ['둘째', '셋째 각주', '넷째 새 번호', '다섯째 책갈피'].forEach((text, i) => {
      doc.splitParagraph(S, i, doc.getParagraphLength(S, i));
      doc.insertText(S, i + 1, 0, text);
    });
    doc.addBookmark(S, 4, 2, '책갈피1');
    doc.insertFootnote(S, 2, 2);
    doc.insertNewNumber(S, 3, 2, 5);
    const editor = new DocumentEditor(doc);
    const before = JSON.stringify(editor.blocks);
    const tail = '. 글자만 옮기려면 insert_paragraph 와 delete_blocks 를 쓰세요.';

    expect(() => editor.edit(move(editor, ['b3', 'b4', 'b5'], 'b2', 'before'), editor.depth)).toThrow(
      [`이 문단은 옮길 수 없습니다(각주): b3${tail}`, `이 문단은 옮길 수 없습니다(새 번호로 시작): b4${tail}`, `이 문단은 옮길 수 없습니다(책갈피): b5${tail}`].join(
        '\n',
      ),
    );
    expect(JSON.stringify(editor.blocks)).toBe(before);
    expect([editor.depth, editor.undo(1, editor.depth)]).toEqual([0, 0]);
  });

  it('AC-5 고른 블록 사이 빈 문단이 거부되면 앞 블록 id 뒤 빈 문단이라고 알린다', () => {
    const doc = createBlankDocument();
    doc.insertText(S, 0, 0, '첫째');
    ['둘째', '', '넷째', '다섯째'].forEach((text, i) => {
      doc.splitParagraph(S, i, doc.getParagraphLength(S, i));
      if (text.length > 0) doc.insertText(S, i + 1, 0, text);
    });
    // 셋째 문단은 각주만 든 빈 문단이라 블록이 아니다
    doc.insertFootnote(S, 2, 0);
    const editor = new DocumentEditor(doc);
    expect(editor.blocks.map(textOf)).toEqual(['첫째', '둘째', '넷째', '다섯째']);

    expect(() => editor.edit(move(editor, ['b2', 'b3'], 'b4', 'after'), editor.depth)).toThrow(
      '이 문단은 옮길 수 없습니다(각주): b2 뒤 빈 문단. 글자만 옮기려면 insert_paragraph 와 delete_blocks 를 쓰세요.',
    );
  });

  it('AC-5 구역 첫 문단은 옮길 수 없고(구역·단 시작 문단), 그 앞으로도 옮기지 않는다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));

    expect(() => editor.edit(move(editor, ['b1'], 'b6', 'after'), editor.depth)).toThrow(
      '이 문단은 옮길 수 없습니다(구역·단 시작 문단): b1. 글자만 옮기려면 insert_paragraph 와 delete_blocks 를 쓰세요.',
    );
    expect(() => editor.edit(move(editor, ['b6'], 'b1', 'before'), editor.depth)).toThrow(
      '구역 첫 문단 앞으로는 옮길 수 없습니다. 첫 문단 뒤로 옮기세요.',
    );
    expect(editor.depth).toBe(0);
  });

  it('옮길 블록 위치가 뷰어 블록과 다르면 get_outline 을 다시 부르라고 한다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    const operation: EditOperation = {
      kind: 'move_blocks',
      section: 0,
      start: 4,
      end: 5,
      before: 1,
      blocks: [{ id: 'b9', anchor: { section: 0, paragraph: 4, part: 'text' } }],
    };
    expect(() => editor.edit(operation, editor.depth)).toThrow('b9: 뷰어 문서에 이 블록이 없습니다. get_outline 을 다시 부르세요.');
  });

  it('옮길 범위에 서버가 모르는 뷰어 블록이 있으면 같이 옮기지 않고 어긋났다고 거부한다 (PR #28 재리뷰)', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    const before = JSON.stringify(editor.blocks);
    // 문단 1 에는 글자(b2)와 누름틀(b3)이 있는데 서버는 글자만 안다
    const operation: EditOperation = {
      kind: 'move_blocks',
      section: 0,
      start: 1,
      end: 2,
      before: 5,
      blocks: [{ id: 'b2', anchor: { section: 0, paragraph: 1, part: 'text' } }],
    };

    expect(() => editor.edit(operation, editor.depth)).toThrow(
      '옮길 범위의 블록이 서버와 뷰어에서 다릅니다(뷰어에만 있는 블록: 문단 1 field:0). open_document 로 문서를 다시 열어 주세요.',
    );
    expect(JSON.stringify(editor.blocks)).toBe(before);
    expect(editor.depth).toBe(0);
  });
});
