// SPEC-002 편집 공용 경로(core/document-editor.ts)와 replace_text 적용(core/edit-operations.ts). 뷰어와 같은 코드를 Node 의 rhwp 로 돌린다.
import type { HwpDocument } from '@rhwp/core';
import { describe, expect, it } from 'vitest';
import { BlockIdTable } from '../src/core/block-ids.ts';
import type { Block } from '../src/core/block-schema.ts';
import { DocumentEditor } from '../src/core/document-editor.ts';
import { UNDO_LIMIT } from '../src/core/edit-history.ts';
import type { EditOperation } from '../src/core/edit-operations.ts';
import { listFields } from '../src/core/edits.ts';
import { blockBoxes } from '../src/core/highlight-targets.ts';
import { createBlankDocument } from '../src/core/rhwp-node.ts';
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
): EditOperation => ({ kind: 'replace_text', target: targetOf(editor, id, extra), text });

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

    const changed = editor.edit(replace(editor, 'b1', 'XYZ', { start: 2, end: 4 }));

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

    editor.edit(replace(editor, 'b11', '회신 기한: 2026. 11. 7.(금)까지 회신하여 주시기 바랍니다.'));

    expect(blockText(editor, 10)).toBe('회신 기한: 2026. 11. 7.(금)까지 회신하여 주시기 바랍니다.');
    expect(charShapeIdAt(doc, 10, 20)).toBe(firstId);
  });

  it('AC-1 표 칸 글자를 바꾸고 칸 첫 글자 모양을 따른다', () => {
    const doc = openFixture('notice.hwpx');
    // b12 표의 (1,1) 칸 "11. 20.(목) 14:00" 은 칸 번호 4
    doc.applyCharFormatInCell(S, 11, 0, 4, 0, 4, 7, JSON.stringify({ bold: true }));
    const editor = new DocumentEditor(doc);
    const boldId = cellCharShapeIdAt(doc, 11, 0, 4, 4);

    const changed = editor.edit(replace(editor, 'b12', '21.', { cell: { row: 1, col: 1 }, start: 4, end: 7 }));

    const table = changed[0]?.block;
    expect(table?.kind === 'table' ? table.cells.find((c) => c.row === 1 && c.col === 1)?.text : undefined).toBe('11. 21.(목) 14:00');
    expect([4, 5, 6].map((offset) => cellCharShapeIdAt(doc, 11, 0, 4, offset))).toEqual([boldId, boldId, boldId]);
  });

  it('AC-1 누름틀 값을 바꾸고 값 첫 글자 모양을 따른다(빈 누름틀은 값을 넣는다)', () => {
    const editor = new DocumentEditor(openFixture('application.hwpx'));
    // b7 = 신청인 누름틀(문단 5)
    editor.edit(replace(editor, 'b7', '홍길동'));
    expect(blockText(editor, 6)).toBe('홍길동');
    const field = listFields(editor.doc).find((f) => f.name === '신청인');
    if (field === undefined) throw new Error('신청인 누름틀이 없다');
    editor.doc.applyCharFormat(S, 5, field.startCharIdx, field.startCharIdx + 3, JSON.stringify({ bold: true }));
    const boldId = charShapeIdAt(editor.doc, 5, field.startCharIdx);

    editor.edit(replace(editor, 'b7', '김철수입니다'));

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

    editor.edit(replace(editor, second, '11월'));
    editor.edit(replace(editor, second, ' 7일', { start: 3, end: 3 }));

    expect(editor.blocks.flatMap((block) => (block.kind === 'field' ? [`${block.name}=${block.value}`] : []))).toEqual([
      '성명=',
      '날짜=11월 7일',
    ]);
  });

  it('빈 글자로 바꾸면 범위를 지운다', () => {
    const editor = mixedEditor();
    editor.edit(replace(editor, 'b1', '', { start: 2, end: 4 }));
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

    expect(() => editor.edit(replace(editor, id, text, extra))).toThrow(message);
    expect(JSON.stringify(editor.blocks)).toBe(before);
    expect(editor.undo(1)).toBe(0);
  });

  it('뷰어 문서에 없는 블록 위치면 get_outline 을 다시 부르라고 한다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    const operation: EditOperation = {
      kind: 'replace_text',
      target: { id: 'b99', anchor: { section: 0, paragraph: 99, part: 'text' } },
      text: 'X',
    };
    expect(() => editor.edit(operation)).toThrow('b99: 뷰어 문서에 이 블록이 없습니다. get_outline 을 다시 부르세요.');
  });

  it('편집하다 중간에 실패하면(글자를 넣은 뒤 지우기에서 rhwp 오류) 스냅샷으로 되돌려 문서는 그대로다', () => {
    const editor = mixedEditor();
    const before = JSON.stringify(editor.blocks);
    const { doc } = editor;
    // 첫 글자 뒤에 새 글자를 넣은 다음 단계(옛 글자 지우기)에서 던지게 한다
    doc.deleteText = () => {
      throw new Error('rhwp 오류');
    };

    expect(() => editor.edit(replace(editor, 'b1', 'XYZ', { start: 2, end: 4 }))).toThrow('rhwp 오류');
    expect(doc.getTextRange(S, 0, 0, doc.getParagraphLength(S, 0))).toBe('가나다라마바');
    expect(JSON.stringify(editor.blocks)).toBe(before);
    expect(editor.undo(1)).toBe(0);
  });
});

describe('SPEC-002 되돌리기 (편집 공용 경로)', () => {
  it('AC-8 편집을 하나씩 되돌리고, 되돌릴 것이 없으면 0 을 돌려준다', () => {
    const editor = mixedEditor();
    editor.edit(replace(editor, 'b1', '하', { start: 0, end: 1 }));
    editor.edit(replace(editor, 'b1', '호', { start: 5, end: 6 }));
    expect(blockText(editor, 0)).toBe('하나다라마호');

    expect(editor.undo(1)).toBe(1);
    expect(blockText(editor, 0)).toBe('하나다라마바');
    expect(editor.undo(1)).toBe(1);
    expect(blockText(editor, 0)).toBe('가나다라마바');
    expect(editor.undo(1)).toBe(0);
  });

  it(`AC-8 ${UNDO_LIMIT}단계까지만 되돌리고, 그보다 옛 편집은 남는다`, () => {
    const editor = mixedEditor();
    for (let i = 0; i <= UNDO_LIMIT; i += 1) editor.edit(replace(editor, 'b1', String(i % 10), { start: 0, end: 1 }));

    expect(editor.undo(UNDO_LIMIT + 5)).toBe(UNDO_LIMIT);
    // 첫 편집("0")은 되돌릴 수 없다
    expect(blockText(editor, 0)).toBe('0나다라마바');
  });

  it('AC-12 문서를 닫을 때 버린 편집 수를 돌려준다', () => {
    const editor = mixedEditor();
    editor.edit(replace(editor, 'b1', 'X', { start: 0, end: 1 }));
    editor.edit(replace(editor, 'b1', 'Y', { start: 0, end: 1 }));
    expect(editor.dispose()).toBe(2);
  });
});

describe('SPEC-002 바뀐 블록 표시 자리', () => {
  it('AC-7 바뀐 블록마다 블록 전체(문단 줄·표)를 감싸는 사각형을 쪽마다 하나 준다', () => {
    const editor = new DocumentEditor(openFixture('notice.hwpx'));
    const paragraph = editor.edit(replace(editor, 'b7', '짧은 문장'));
    const table = editor.edit(replace(editor, 'b12', '3회차', { cell: { row: 2, col: 0 } }));

    const [paragraphBox] = blockBoxes(editor.doc, editor.blocks, paragraph.map(({ anchor }) => anchor));
    const tableBoxes = blockBoxes(editor.doc, editor.blocks, table.map(({ anchor }) => anchor));

    expect(paragraphBox?.width).toBeGreaterThan(0);
    expect(tableBoxes).toHaveLength(1);
    expect(tableBoxes[0]?.height).toBeGreaterThan(paragraphBox?.height ?? 0);
  });

  it('글자를 모두 지운 빈 문단은 표시할 자리가 없어 건너뛴다', () => {
    const editor = mixedEditor();
    const changed = editor.edit(replace(editor, 'b1', ''));
    expect(blockBoxes(editor.doc, editor.blocks, changed.map(({ anchor }) => anchor))).toEqual([]);
  });
});
