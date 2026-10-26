import { describe, expect, it } from 'vitest';
import type { Block } from '../src/core/block-schema.ts';
import { extractBlocks } from '../src/core/blocks.ts';
import { findInBlocks } from '../src/core/find-text.ts';
import { openFixture } from './fixtures.ts';

const paragraph = (paragraphIndex: number, text: string): Block => ({
  kind: 'paragraph',
  section: 0,
  paragraph: paragraphIndex,
  page: 1,
  text,
});

describe('SPEC-001 글자 찾기 (find_text)', () => {
  it('일치하는 모든 위치의 블록·범위(시작·끝 글자 위치)·앞뒤 20자를 돌려준다', () => {
    const text = '가나다라마바사아자차카타파하거너더러머버서어 회신 기한은 11월 14일이며 늦은 회신은 받지 않습니다';
    const matches = findInBlocks([paragraph(0, '관련 없는 문단'), paragraph(3, text)], '회신');

    const first = text.indexOf('회신');
    const second = text.lastIndexOf('회신');
    expect(matches).toEqual([
      {
        block: { kind: 'paragraph', section: 0, paragraph: 3 },
        start: first,
        end: first + 2,
        before: text.slice(first - 20, first),
        after: text.slice(first + 2, first + 22),
      },
      {
        block: { kind: 'paragraph', section: 0, paragraph: 3 },
        start: second,
        end: second + 2,
        before: text.slice(second - 20, second),
        after: text.slice(second + 2),
      },
    ]);
    expect(matches[0]?.before).toHaveLength(20);
  });

  it('블록 처음·끝에 붙은 일치는 있는 만큼만 앞뒤 문맥을 준다', () => {
    const [match] = findInBlocks([paragraph(0, '회신 기한')], '회신');
    expect(match).toMatchObject({ start: 0, end: 2, before: '', after: ' 기한' });
  });

  it('겹치는 일치는 앞에서부터 겹치지 않게 센다', () => {
    const matches = findInBlocks([paragraph(0, '가가가')], '가가');
    expect(matches.map((m) => [m.start, m.end])).toEqual([[0, 2]]);
  });

  it('표 칸 안 일치는 칸 좌표(행·열)와 칸 텍스트 안 범위를 준다', () => {
    const blocks = extractBlocks(openFixture('notice.hwpx'));
    const matches = findInBlocks(blocks, '소강당');

    expect(matches).toEqual([
      {
        block: { kind: 'table', section: 0, paragraph: 11, controlIndex: 0 },
        cell: { row: 2, col: 2 },
        start: 5,
        end: 8,
        before: '구민회관 ',
        after: '',
      },
    ]);
  });

  it('누름틀 블록은 따로 찾지 않는다(값은 누름틀이 든 문단·칸 텍스트에 들어 있다)', () => {
    const field: Block = {
      kind: 'field',
      section: 0,
      paragraph: 0,
      page: 1,
      name: '수신',
      guide: '받는 곳',
      value: '각 동 주민센터',
      inTable: false,
    };
    const matches = findInBlocks([paragraph(0, '수신 각 동 주민센터'), field], '주민센터');
    expect(matches.map((m) => m.block.kind)).toEqual(['paragraph']);
  });

  it('일치가 없으면 빈 목록을 돌려준다', () => {
    expect(findInBlocks(extractBlocks(openFixture('notice.hwpx')), '없는 낱말')).toEqual([]);
  });
});
