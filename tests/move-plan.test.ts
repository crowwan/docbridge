// SPEC-002 move_blocks 계획(server/move-plan.ts): 고른 블록 → 옮길 문단 범위, 거부 조건. id 표만으로 계산한다.
import { describe, expect, it } from 'vitest';
import { BlockIdTable, type BlockPosition } from '../src/core/block-ids.ts';
import { extractBlocks } from '../src/core/blocks.ts';
import { noParagraphChanges, relocate } from '../src/core/paragraph-changes.ts';
import { hasTypedNumber } from '../src/server/edit-tools.ts';
import { DIFFERENT_SECTION, planMove } from '../src/server/move-plan.ts';
import { openFixture } from './fixtures.ts';

// notice.hwpx: b2(문단 1)·b3(문단 1 누름틀), b5(문단 3), 문단 4 는 빈 문단, b6~b11(문단 5~10, 번호 1. 2. 가. 나. 다. 3.), b12 표(문단 11)
const noticeIds = () => BlockIdTable.assign(extractBlocks(openFixture('notice.hwpx')));
const anchor = (paragraph: number, part = 'text') => ({ section: 0, paragraph, part });

describe('SPEC-002 문단 옮기기 계획 (move_blocks)', () => {
  it('AC-4 고른 블록이 든 문단 범위와 기준 블록 앞(뒤) 자리를 정한다', () => {
    expect(planMove(noticeIds(), ['b11'], 'b6', 'before')).toEqual({
      section: 0,
      start: 10,
      end: 11,
      before: 5,
      blocks: [{ id: 'b11', anchor: anchor(10) }],
      // 옛 자리와 새 자리 사이에서 순서가 바뀐 블록
      shifted: ['b6', 'b7', 'b8', 'b9', 'b10'],
    });
    expect(planMove(noticeIds(), ['b6'], 'b12', 'after')).toMatchObject({ start: 5, end: 6, before: 12 });
  });

  it('AC-4 옮기는 단위는 문단이라 같은 문단의 누름틀과 고른 블록 사이 빈 문단도 같이 옮긴다', () => {
    expect(planMove(noticeIds(), ['b2'], 'b7', 'after').blocks).toEqual([
      { id: 'b2', anchor: anchor(1) },
      { id: 'b3', anchor: anchor(1, 'field:0') },
    ]);
    // 문단 4 는 블록이 없는 빈 문단: b5 와 b6 은 이어진 것으로 보고 빈 문단째 옮긴다
    expect(planMove(noticeIds(), ['b5', 'b6'], 'b12', 'after')).toMatchObject({ start: 3, end: 6 });
  });

  it('같은 id 를 여러 번 주면 한 번으로 본다', () => {
    expect(planMove(noticeIds(), ['b11', 'b11'], 'b6', 'before').blocks).toHaveLength(1);
  });

  it('이어지지 않은 ids 는 사이 블록 id 를 알려 주며 거부한다', () => {
    expect(() => planMove(noticeIds(), ['b6', 'b8'], 'b12', 'after')).toThrow(
      '옮길 블록이 문서에서 이어져 있지 않습니다. 사이 블록 b7 도 ids 에 넣거나 따로 옮기세요.',
    );
  });

  it('기준 블록이 옮길 블록 안(같은 문단의 누름틀 포함)이면 거부한다', () => {
    expect(() => planMove(noticeIds(), ['b6', 'b7'], 'b7', 'after')).toThrow('기준 블록 b7 가 옮길 블록 안에 있습니다.');
    expect(() => planMove(noticeIds(), ['b2'], 'b3', 'before')).toThrow('기준 블록 b3 가 옮길 블록 안에 있습니다.');
  });

  it('이미 기준 블록 바로 앞(뒤)에 있으면 옮길 것이 없어 거부한다', () => {
    expect(() => planMove(noticeIds(), ['b6'], 'b7', 'before')).toThrow('b6 은 이미 b7 앞에 있습니다. 옮길 것이 없습니다.');
    expect(() => planMove(noticeIds(), ['b7'], 'b6', 'after')).toThrow('b7 은 이미 b6 뒤에 있습니다. 옮길 것이 없습니다.');
  });

  it('블록 없는 빈 문단만 사이에 있어도 블록 순서로 이미 그 자리면 거부한다 (PR #28 리뷰)', () => {
    // b5(문단 3) 와 b6(문단 5) 사이 문단 4 는 빈 문단
    expect(() => planMove(noticeIds(), ['b5'], 'b6', 'before')).toThrow('b5 은 이미 b6 앞에 있습니다. 옮길 것이 없습니다.');
    expect(() => planMove(noticeIds(), ['b6'], 'b5', 'after')).toThrow('b6 은 이미 b5 뒤에 있습니다. 옮길 것이 없습니다.');
    // 사이에 블록이 있으면 옮긴다
    expect(planMove(noticeIds(), ['b5'], 'b7', 'before')).toMatchObject({ start: 3, end: 4, before: 6 });
  });

  it('기준 블록이 같은 문단의 다른 블록과 이웃하면 문단 가운데로는 옮길 수 없다고 거부한다 (PR #28 재리뷰)', () => {
    // 문단 1 = b2(글자) + b3(누름틀)
    const middle = '는 다른 블록과 같은 문단(b2, b3)에 있어 그 사이로는 옮길 수 없습니다. b2 앞이나 b3 뒤로 옮기세요.';
    expect(() => planMove(noticeIds(), ['b4'], 'b2', 'after')).toThrow(`기준 블록 b2 ${middle}`);
    expect(() => planMove(noticeIds(), ['b5'], 'b3', 'before')).toThrow(`기준 블록 b3 ${middle}`);
    // 문단 처음 블록 앞, 마지막 블록 뒤는 블록 순서로 판정한다
    expect(planMove(noticeIds(), ['b5'], 'b2', 'before')).toMatchObject({ before: 1 });
    expect(planMove(noticeIds(), ['b5'], 'b3', 'after')).toMatchObject({ before: 2 });
    expect(() => planMove(noticeIds(), ['b4'], 'b3', 'after')).toThrow('b4 은 이미 b3 뒤에 있습니다. 옮길 것이 없습니다.');
  });

  it('누름틀 블록만 고르면 누름틀이 든 블록을 옮기라고 거부한다. 누름틀 말고 블록이 없는 문단은 누름틀로 고른다', () => {
    expect(() => planMove(noticeIds(), ['b3'], 'b7', 'after')).toThrow(
      'b3: 누름틀 블록만 옮길 수는 없습니다. 누름틀이 든 블록 b2 를 옮기세요.',
    );
    // 빈 누름틀만 든 문단(문단 블록 없음)
    const positions: BlockPosition[] = [
      { kind: 'paragraph', section: 0, paragraph: 1 },
      { kind: 'field', section: 0, paragraph: 2 },
      { kind: 'paragraph', section: 0, paragraph: 3 },
    ];
    expect(planMove(BlockIdTable.assign(positions), ['b2'], 'b1', 'before')).toMatchObject({ start: 2, end: 3, before: 1 });
  });

  it('표 칸 안 누름틀만 골라도 표 블록을 옮기라고 거부한다', () => {
    const positions: BlockPosition[] = [
      { kind: 'paragraph', section: 0, paragraph: 1 },
      { kind: 'table', section: 0, paragraph: 2, controlIndex: 0 },
      { kind: 'field', section: 0, paragraph: 2 },
    ];
    expect(() => planMove(BlockIdTable.assign(positions), ['b3'], 'b1', 'before')).toThrow(
      'b3: 누름틀 블록만 옮길 수는 없습니다. 누름틀이 든 블록 b2 를 옮기세요.',
    );
  });

  it('옮길 블록끼리나 기준 블록이 다른 구역이면 거부한다', () => {
    const positions: BlockPosition[] = [
      { kind: 'paragraph', section: 0, paragraph: 1 },
      { kind: 'paragraph', section: 0, paragraph: 2 },
      { kind: 'paragraph', section: 1, paragraph: 1 },
    ];
    const ids = BlockIdTable.assign(positions);
    expect(() => planMove(ids, ['b2'], 'b3', 'after')).toThrow(DIFFERENT_SECTION);
    expect(() => planMove(ids, ['b2', 'b3'], 'b1', 'before')).toThrow(DIFFERENT_SECTION);
  });

  it('id 표의 id 목록은 블록 목록과 같은 문서 순서다(같은 문단은 문단 글자 → 표 → 누름틀)', () => {
    for (const name of ['notice.hwpx', 'application.hwpx', 'report.hwpx']) {
      const blocks = extractBlocks(openFixture(name));
      const ids = BlockIdTable.assign(blocks);
      expect(ids.entries(0).map(({ id }) => id)).toEqual(ids.label(blocks).map(({ id }) => id));
    }
  });

  it('AC-4 옮긴 범위(changes.moved)의 relocate 와 id 표 paragraphsMoved 는 같은 자리로 옮긴다(앞으로·뒤로)', () => {
    for (const moved of [
      { section: 0, start: 10, end: 11, before: 5 },
      { section: 0, start: 5, end: 10, before: 11 },
    ]) {
      const ids = noticeIds();
      const before = ids.entries(0);
      ids.paragraphsMoved(moved.section, moved.start, moved.end, moved.before);
      const toAfter = relocate({ ...noParagraphChanges(), moved });
      expect(before.map(({ id, anchor }) => ({ id, paragraph: toAfter(anchor)?.paragraph }))).toEqual(
        before.map(({ id }) => ({ id, paragraph: ids.anchor(id)?.paragraph })),
      );
    }
  });

  it('없는 id 는 모두 모아 알려 준다', () => {
    expect(() => planMove(noticeIds(), ['b6', 'b98'], 'b99', 'before')).toThrow(
      '없는 블록 id 입니다: b98, b99. get_outline 을 다시 불러 지금 블록 id 를 확인하세요.',
    );
  });
});

describe('SPEC-002 직접 입력한 번호 판정', () => {
  it.each(['1. 관련', '12) 기한', '가. 대상', '하) 끝', '(1) 첫째', '(가) 첫째', '（3） 전각', '(2)', '① 동그라미', '㉠ 기역', '㉮ 가', '⑳', 'Ⅳ. 로마', '  2. 앞 공백', '3.'])(
    'AC-6 "%s" 는 직접 입력한 번호다',
    (text) => expect(hasTypedNumber(text)).toBe(true),
  );

  it.each(['2026. 11. 14.(금)까지', '123. 세 자리', '1.5배 늘었다', '가나다구청', '거. 가~하 밖', '참고 1. 수치', '제목', '(경유)', '', '①번 항목은 삭제', '㉠항목', '(사)한국도서관협회', '(1)항', 'Ⅱ.사업'])(
    'AC-6 "%s" 는 직접 입력한 번호가 아니다',
    (text) => expect(hasTypedNumber(text)).toBe(false),
  );
});
