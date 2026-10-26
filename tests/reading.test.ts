import { describe, expect, it } from 'vitest';
import { BlockIdTable } from '../src/core/block-ids.ts';
import type { Block } from '../src/core/block-schema.ts';
import { extractBlocks } from '../src/core/blocks.ts';
import {
  OUTLINE_LIMIT,
  READ_CHAR_LIMIT,
  outline,
  readBlocks,
  selectionFrom,
  type LabeledBlock,
  type ReadBlock,
} from '../src/server/reading.ts';
import { openFixture } from './fixtures.ts';

const labeled = (blocks: Block[]): LabeledBlock[] =>
  blocks.map((block, i) => ({ id: `b${i + 1}`, block }));

const paragraphs = (count: number, text = '문단', page = (i: number) => i + 1): LabeledBlock[] =>
  labeled(
    Array.from({ length: count }, (_, i) => ({ kind: 'paragraph' as const, section: 0, paragraph: i, page: page(i), text })),
  );

/** 실제로 내보내는 글자 필드(id·kind 같은 구조 값 제외)의 길이 합 */
function sentTextLength(blocks: ReadBlock[]): number {
  return blocks.reduce((sum, block) => {
    switch (block.kind) {
      case 'paragraph':
        return sum + block.text.length + (block.number?.length ?? 0);
      case 'table':
        return sum + block.cells.reduce((cellSum, cell) => cellSum + cell.text.length + cell.rowLabel.length, 0);
      case 'field':
        return sum + block.name.length + block.guide.length + block.value.length;
    }
  }, 0);
}

const noticeBlocks = () => {
  const blocks = extractBlocks(openFixture('notice.hwpx'));
  return BlockIdTable.assign(blocks)
    .label(blocks)
    .flatMap(({ id, block }) => (id === undefined ? [] : [{ id, block }]));
};

describe('SPEC-001 문서 개요 (get_outline)', () => {
  it('본문 문단·표·누름틀을 문서 순서대로 id·kind·쪽·앞 40자와 함께 돌려주고, 자동 번호 문단은 번호 문자열을 포함한다', () => {
    const result = outline(noticeBlocks());

    expect(result.blockCount).toBe(14);
    expect(result.more).toBeUndefined();
    expect(result.blocks.map((b) => b.kind)).toEqual([
      'paragraph', 'paragraph', 'field', 'paragraph', 'paragraph',
      'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph',
      'table', 'paragraph', 'paragraph',
    ]);
    expect(result.blocks[0]).toEqual({ id: 'b1', kind: 'paragraph', page: 1, text: '가나다구청' });
    const long = '하반기 주민 안전교육을 아래와 같이 실시하오니 각 동 주민센터에서는 주민들이 참여할 수 있도록 안내하여 주시기 바랍니다.';
    expect(result.blocks.find((b) => b.number === '2.')).toEqual({
      id: 'b7',
      kind: 'paragraph',
      page: 1,
      text: `${[...long].slice(0, 40).join('')}…`,
      number: '2.',
    });
    expect(result.blocks.find((b) => b.number === '2.')?.text).toHaveLength(41);
    expect(result.blocks.find((b) => b.kind === 'field')).toEqual({
      id: 'b3',
      kind: 'field',
      page: 1,
      text: '',
      name: '수신',
    });
    expect(result.blocks.find((b) => b.kind === 'table')?.text).toBe('구분 | 일정 | 장소 | 1회차 | 11. 20.(목) 14:00 | …');
  });

  it('개요 문단은 개요 수준을 함께 준다', () => {
    const blocks = extractBlocks(openFixture('outline-demo.hwpx'));
    const result = outline(labeled(blocks));
    expect(result.blocks.filter((b) => b.outlineLevel !== undefined).slice(0, 3).map((b) => [b.number, b.outlineLevel])).toEqual([
      ['1.', 1],
      ['가.', 2],
      ['1)', 3],
    ]);
  });

  it('블록이 500개를 넘으면 500개에서 자르고 from 으로 이어 받는 방법을 알려준다', () => {
    const result = outline(paragraphs(OUTLINE_LIMIT + 20));

    expect(result.blockCount).toBe(520);
    expect(result.blocks).toHaveLength(OUTLINE_LIMIT);
    expect(result.blocks.at(-1)?.id).toBe('b500');
    expect(result.more).toEqual({
      message: '블록이 520개라 1~500번째만 보냈습니다. 나머지는 get_outline 을 from: "b501" 로 다시 부르세요.',
      next: { from: 'b501' },
    });
  });

  it('from 을 주면 그 블록부터 이어서 돌려준다', () => {
    const result = outline(paragraphs(OUTLINE_LIMIT + 20), 'b501');

    expect(result.blocks.map((b) => b.id)).toEqual(Array.from({ length: 20 }, (_, i) => `b${501 + i}`));
    expect(result.more).toBeUndefined();
  });

  it('없는 from id 면 그 id 를 알려주고 get_outline 을 다시 부르라고 안내한다', () => {
    expect(() => outline(paragraphs(3), 'b99')).toThrow(
      '없는 블록 id 입니다: b99. get_outline 을 다시 불러 지금 블록 id 를 확인하세요.',
    );
  });
});

describe('SPEC-001 블록 읽기 (read_blocks)', () => {
  it('표 블록에 대해 칸마다 행,열·텍스트·같은 행 첫 칸 텍스트를 돌려준다', () => {
    const blocks = noticeBlocks();
    const table = blocks.find(({ block }) => block.kind === 'table');
    if (table === undefined) throw new Error('표가 없다');

    const result = readBlocks(blocks, { ids: [table.id] });

    expect(result.more).toBeUndefined();
    expect(result.blocks).toHaveLength(1);
    const [read] = result.blocks;
    expect(read).toMatchObject({ id: table.id, kind: 'table', page: 1, rowCount: 3, colCount: 3 });
    expect(read?.kind === 'table' ? read.cells : []).toContainEqual({ row: 2, col: 2, text: '구민회관 소강당', rowLabel: '2회차' });
    expect(read?.kind === 'table' ? read.cells : []).toHaveLength(9);
  });

  it('ids 로 고른 블록의 전문을 준 순서대로 돌려준다', () => {
    const blocks = noticeBlocks();
    const result = readBlocks(blocks, { ids: ['b6', 'b1', 'b6'] });

    expect(result.blocks.map((b) => b.id)).toEqual(['b6', 'b1']);
    expect(result.blocks[0]).toEqual({
      id: 'b6',
      kind: 'paragraph',
      page: 1,
      text: blocks[5]?.block.kind === 'paragraph' ? blocks[5].block.text : '',
      number: '1.',
    });
  });

  it('쪽 범위로 고르면 그 쪽들의 블록을 문서 순서대로 돌려준다', () => {
    const result = readBlocks(paragraphs(6, '문단', (i) => Math.floor(i / 2) + 1), { fromPage: 2, toPage: 3 });
    expect(result.blocks.map((b) => [b.id, b.page])).toEqual([
      ['b3', 2],
      ['b4', 2],
      ['b5', 3],
      ['b6', 3],
    ]);
  });

  it('없는 블록 id 가 있으면 그 id 를 알려주고 get_outline 을 다시 부르라고 안내한다', () => {
    expect(() => readBlocks(paragraphs(3), { ids: ['b2', 'b77', 'b88'] })).toThrow(
      '없는 블록 id 입니다: b77, b88. get_outline 을 다시 불러 지금 블록 id 를 확인하세요.',
    );
  });

  it('글자가 20,000자를 넘으면 넘기 전 블록까지 돌려주고 남은 ids 로 이어 받는 방법을 알려준다', () => {
    const blocks = paragraphs(5, '가'.repeat(6_000));

    const result = readBlocks(blocks, { ids: ['b1', 'b2', 'b3', 'b4', 'b5'] });

    expect(result.blocks.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
    expect(result.more).toEqual({
      message: '글자가 20,000자를 넘어 블록 5개 중 3개만 보냈습니다. 나머지는 read_blocks 를 more.next 의 인자로 다시 부르세요.',
      next: { ids: ['b4', 'b5'] },
    });
  });

  it('쪽 범위로 읽다가 20,000자를 넘으면 같은 쪽 범위와 from 으로 이어 받게 한다', () => {
    const blocks = paragraphs(5, '가'.repeat(6_000), () => 1);

    const first = readBlocks(blocks, { fromPage: 1, toPage: 1 });
    expect(first.more?.next).toEqual({ fromPage: 1, toPage: 1, from: 'b4' });

    const rest = readBlocks(blocks, { fromPage: 1, toPage: 1, from: 'b4' });
    expect(rest.blocks.map((b) => b.id)).toEqual(['b4', 'b5']);
    expect(rest.more).toBeUndefined();
  });

  it('블록 하나가 혼자 20,000자를 넘으면 그 블록을 잘라 보내고 잘렸다고 알린다', () => {
    const blocks = paragraphs(2, '가'.repeat(READ_CHAR_LIMIT + 500));

    const result = readBlocks(blocks, { ids: ['b1', 'b2'] });

    expect(result.blocks).toHaveLength(1);
    const [read] = result.blocks;
    expect(read?.kind === 'paragraph' ? read.text : '').toHaveLength(READ_CHAR_LIMIT);
    expect(read).toMatchObject({ id: 'b1', truncated: true });
    expect(result.more).toEqual({
      message:
        '글자가 20,000자를 넘어 블록 2개 중 1개만 보냈습니다. b1: 20,500자 중 앞 20,000자만 보냈습니다. 나머지는 read_blocks 를 more.next 의 인자로 다시 부르세요.',
      next: { ids: ['b2'] },
    });
  });

  it('글자 수는 유니코드 글자로 세고, 자를 때 이모지·확장 한자를 반쪽 내지 않는다', () => {
    const blocks = paragraphs(1, '😀𠀀'.repeat(READ_CHAR_LIMIT / 2 + 1));

    const [read] = readBlocks(blocks, { ids: ['b1'] }).blocks;
    const text = read?.kind === 'paragraph' ? read.text : '';

    expect([...text]).toHaveLength(READ_CHAR_LIMIT);
    expect(text).toBe('😀𠀀'.repeat(READ_CHAR_LIMIT / 2));
  });

  it('큰 표 하나가 20,000자를 넘으면 들어가는 칸까지만 보낸다(칸마다 반복되는 라벨도 센다)', () => {
    // 칸마다 text 1,000자 + rowLabel 1,000자 = 2,000자, 30칸이면 60,000자
    const cells = Array.from({ length: 30 }, (_, i) => ({ row: i, col: 1, text: '가'.repeat(1_000), rowLabel: '나'.repeat(1_000) }));
    const blocks = labeled([
      { kind: 'table', section: 0, paragraph: 0, controlIndex: 0, page: 1, rowCount: 30, colCount: 2, cells },
    ]);

    const result = readBlocks(blocks, { ids: ['b1'] });

    const [read] = result.blocks;
    expect(read?.kind === 'table' ? read.cells : []).toHaveLength(10);
    expect(read).toMatchObject({ truncated: true });
    expect(result.more?.message).toBe('b1: 60,000자 중 앞 20,000자만 보냈습니다.');
    expect(result.more?.next).toBeUndefined();
    expect(sentTextLength(result.blocks)).toBeLessThanOrEqual(READ_CHAR_LIMIT);
  });

  it('보내는 글자(문단 번호, 칸 라벨, 누름틀 이름·안내문·값)를 모두 세어 20,000자를 넘기지 않는다', () => {
    const table = Array.from({ length: 4 }, (_, i) => ({
      kind: 'table' as const,
      section: 0,
      paragraph: i,
      controlIndex: 0,
      page: 1,
      rowCount: 10,
      colCount: 2,
      cells: Array.from({ length: 10 }, (_, r) => ({ row: r, col: 1, text: '가'.repeat(100), rowLabel: '나'.repeat(200) })),
    }));
    const fields = Array.from({ length: 10 }, (_, i) => ({
      kind: 'field' as const,
      section: 0,
      paragraph: 10 + i,
      page: 1,
      name: '이'.repeat(500),
      guide: '안'.repeat(500),
      value: '값'.repeat(100),
      inTable: false,
    }));
    const blocks = labeled([...table, ...fields]);

    const result = readBlocks(blocks, { ids: blocks.map(({ id }) => id) });

    // 표 4개 × 3,000자 = 12,000, 누름틀 하나 1,100자 → 7개까지 19,700자
    expect(result.blocks.map((b) => b.kind)).toEqual([...Array(4).fill('table'), ...Array(7).fill('field')]);
    expect(sentTextLength(result.blocks)).toBe(19_700);
    expect(result.more?.next).toEqual({ ids: ['b12', 'b13', 'b14'] });
  });
});

describe('SPEC-001 블록 읽기 인자 검사 (read_blocks)', () => {
  const PAGES = 3;

  it.each([
    [{}, '읽을 블록을 ids 나 fromPage(·toPage) 로 정하세요.'],
    [{ toPage: 2 }, '읽을 블록을 ids 나 fromPage(·toPage) 로 정하세요.'],
    [{ ids: ['b1'], fromPage: 1 }, 'ids 와 쪽 범위(fromPage·toPage) 중 하나만 주세요.'],
    [{ ids: ['b1'], from: 'b2' }, 'from 은 쪽 범위(fromPage·toPage)와 함께만 씁니다. ids 로 이어 읽을 때는 more.next 의 ids 를 그대로 주세요.'],
    [{ fromPage: 0 }, '쪽 번호는 1부터입니다(fromPage: 0).'],
    [{ fromPage: 1, toPage: 0 }, '쪽 번호는 1부터입니다(toPage: 0).'],
    [{ fromPage: 3, toPage: 2 }, 'fromPage(3)가 toPage(2)보다 뒤입니다. fromPage 는 toPage 보다 작거나 같아야 합니다.'],
    [{ fromPage: 5 }, '이 문서는 3쪽까지입니다(fromPage: 5).'],
    [{ fromPage: 2, toPage: 9 }, '이 문서는 3쪽까지입니다(toPage: 9).'],
  ])('잘못된 조합·쪽 범위 %j 는 빈 결과 대신 분명한 오류로 거부한다', (args, message) => {
    expect(() => selectionFrom(args, PAGES)).toThrow(message);
  });

  it('맞는 인자는 고르는 방법 하나로 바꾼다(toPage 가 없으면 fromPage 한 쪽)', () => {
    expect(selectionFrom({ ids: ['b1'] }, PAGES)).toEqual({ ids: ['b1'] });
    expect(selectionFrom({ fromPage: 2 }, PAGES)).toEqual({ fromPage: 2, toPage: 2 });
    expect(selectionFrom({ fromPage: 1, toPage: 3, from: 'b4' }, PAGES)).toEqual({ fromPage: 1, toPage: 3, from: 'b4' });
  });
});
