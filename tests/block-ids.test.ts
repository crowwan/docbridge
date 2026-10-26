import { describe, expect, it } from 'vitest';
import { BlockIdTable } from '../src/core/block-ids.ts';
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
