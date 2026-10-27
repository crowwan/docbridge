import { describe, expect, it } from 'vitest';
import { BlockIdTable } from '../src/core/block-ids.ts';
import { blockPositionSchema } from '../src/core/block-schema.ts';
import { extractBlocks, type Block } from '../src/core/blocks.ts';
import { openFixture } from './fixtures.ts';

const SECTION = 0;

// 블록을 비교할 수 있게 위치를 뺀 내용만 남긴다
function content(block: Block): string {
  switch (block.kind) {
    case 'paragraph':
      return `문단:${block.text}`;
    case 'table':
      return `표:${block.cells.map((c) => c.text).join('|')}`;
    case 'field':
      return `누름틀:${block.name}`;
  }
}

function contentById(table: BlockIdTable, blocks: Block[]): Map<string, string> {
  return new Map(
    table.label(blocks).flatMap(({ id, block }) => (id === undefined ? [] : [[id, content(block)] as const])),
  );
}

describe('SPEC-001 블록 id (기술 검증)', () => {
  it('문서를 열면 블록마다 문서 순서대로 b1, b2 … 를 붙인다', () => {
    const blocks = extractBlocks(openFixture('notice.hwpx'));
    const labeled = BlockIdTable.assign(blocks).label(blocks);
    expect(labeled.slice(0, 3).map(({ id }) => id)).toEqual(['b1', 'b2', 'b3']);
    expect(labeled.every(({ id }) => id !== undefined)).toBe(true);
  });

  it('블록에서 id 를 붙일 위치만 뽑는다(표는 컨트롤 번호까지)', () => {
    const blocks = extractBlocks(openFixture('notice.hwpx'));
    const positions = blocks.map((block) => blockPositionSchema.parse(block));
    expect(positions[0]).toEqual({ kind: 'paragraph', section: 0, paragraph: 0 });
    expect(positions.find((p) => p.kind === 'table')).toEqual({ kind: 'table', section: 0, paragraph: 11, controlIndex: 0 });
    expect(positions.find((p) => p.kind === 'field')).toEqual({ kind: 'field', section: 0, paragraph: 1 });
  });

  it('문단을 넣어도 기존 블록의 id 는 같은 내용을 가리킨다', () => {
    const doc = openFixture('notice.hwpx');
    const before = extractBlocks(doc);
    const ids = BlockIdTable.assign(before);
    const expected = contentById(ids, before);

    doc.insertParagraph(SECTION, 2);
    doc.insertText(SECTION, 2, 0, '새로 넣은 문단');
    const newId = ids.paragraphInserted(SECTION, 2);

    const after = contentById(ids, extractBlocks(doc));
    expect(after.get(newId)).toBe('문단:새로 넣은 문단');
    for (const [id, text] of expected) expect(after.get(id)).toBe(text);
  });

  it('문단을 지우면 그 블록 id 만 사라지고 나머지는 같은 내용을 가리킨다', () => {
    const doc = openFixture('notice.hwpx');
    const before = extractBlocks(doc);
    const ids = BlockIdTable.assign(before);
    const expected = contentById(ids, before);
    const removed = ids.label(before).find(({ block }) => block.kind === 'paragraph' && block.number === '1.');
    if (removed?.id === undefined) throw new Error('번호 1. 문단이 없다');

    doc.deleteParagraph(SECTION, removed.block.paragraph);
    ids.paragraphDeleted(SECTION, removed.block.paragraph);

    const afterBlocks = extractBlocks(doc);
    const after = contentById(ids, afterBlocks);
    expect(ids.anchor(removed.id)).toBeUndefined();
    for (const [id, text] of expected) {
      if (id !== removed.id) expect(after.get(id)).toBe(text);
    }
    // 자동 번호는 렌더링 때 다시 계산되므로 다음 번호 문단이 1. 이 된다
    const renumbered = afterBlocks.find((b) => b.kind === 'paragraph' && b.text.startsWith('하반기'));
    expect(renumbered?.kind === 'paragraph' ? renumbered.number : undefined).toBe('1.');
  });

  it('문단을 넣고 지운 뒤에도 블록 위치로 찾은 id 가 같은 블록을 가리킨다', () => {
    const ids = BlockIdTable.assign([
      { kind: 'paragraph', section: 0, paragraph: 0 },
      { kind: 'paragraph', section: 0, paragraph: 1 },
      { kind: 'table', section: 0, paragraph: 2, controlIndex: 0 },
    ]);
    expect(ids.idOf({ kind: 'table', section: 0, paragraph: 2, controlIndex: 0 })).toBe('b3');

    const inserted = ids.paragraphInserted(0, 1);

    expect(ids.idOf({ kind: 'paragraph', section: 0, paragraph: 1 })).toBe(inserted);
    expect(ids.idOf({ kind: 'table', section: 0, paragraph: 3, controlIndex: 0 })).toBe('b3');
    expect(ids.idOf({ kind: 'table', section: 0, paragraph: 2, controlIndex: 0 })).toBeUndefined();

    ids.paragraphDeleted(0, 0);

    expect(ids.idOf({ kind: 'paragraph', section: 0, paragraph: 0 })).toBe(inserted);
    expect(ids.idOf({ kind: 'table', section: 0, paragraph: 2, controlIndex: 0 })).toBe('b3');
  });

  it('같은 문단에 걸린 블록의 id 와 위치를 모두 돌려준다', () => {
    const ids = BlockIdTable.assign([
      { kind: 'paragraph', section: 0, paragraph: 0 },
      { kind: 'paragraph', section: 0, paragraph: 1 },
      { kind: 'field', section: 0, paragraph: 1 },
      { kind: 'table', section: 0, paragraph: 1, controlIndex: 2 },
    ]);

    expect(ids.anchorsAt(0, 1)).toEqual([
      { id: 'b2', anchor: { section: 0, paragraph: 1, part: 'text' } },
      { id: 'b3', anchor: { section: 0, paragraph: 1, part: 'field:0' } },
      { id: 'b4', anchor: { section: 0, paragraph: 1, part: 'table:2' } },
    ]);
    expect(ids.anchorsAt(0, 5)).toEqual([]);
  });

  it('표만 지우면 그 표 id 만 사라지고 같은 문단 뒤 표들의 컨트롤 번호가 당겨진다 (SPEC-002 AC-3)', () => {
    const ids = BlockIdTable.assign([
      { kind: 'paragraph', section: 0, paragraph: 1 },
      { kind: 'table', section: 0, paragraph: 1, controlIndex: 0 },
      { kind: 'table', section: 0, paragraph: 1, controlIndex: 1 },
      { kind: 'table', section: 0, paragraph: 2, controlIndex: 1 },
    ]);

    ids.tableDeleted(0, 1, 0);

    expect(ids.anchor('b2')).toBeUndefined();
    expect(ids.idOf({ kind: 'paragraph', section: 0, paragraph: 1 })).toBe('b1');
    expect(ids.idOf({ kind: 'table', section: 0, paragraph: 1, controlIndex: 0 })).toBe('b3');
    expect(ids.idOf({ kind: 'table', section: 0, paragraph: 2, controlIndex: 1 })).toBe('b4');
  });

  it('대응표를 고치지 않으면 문단을 넣은 뒤 id 가 다른 내용을 가리킨다', () => {
    const doc = openFixture('notice.hwpx');
    const before = extractBlocks(doc);
    const ids = BlockIdTable.assign(before);
    const expected = contentById(ids, before);

    doc.insertParagraph(SECTION, 2);
    doc.insertText(SECTION, 2, 0, '새로 넣은 문단');

    const after = contentById(ids, extractBlocks(doc));
    const moved = [...expected].filter(([id, text]) => after.get(id) !== text);
    expect(moved.length).toBeGreaterThan(0);
  });
});
