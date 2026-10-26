import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractBlocks, type Block, type ParagraphBlock, type TableBlock } from '../src/core/blocks.ts';
import { openFixture } from './fixtures.ts';

const paragraphs = (blocks: Block[]) => blocks.filter((b): b is ParagraphBlock => b.kind === 'paragraph');
const tables = (blocks: Block[]) => blocks.filter((b): b is TableBlock => b.kind === 'table');

describe('SPEC-001 블록 추출 (기술 검증)', () => {
  it('본문 문단·표·누름틀을 문서 순서대로 뽑는다', () => {
    const blocks = extractBlocks(openFixture('notice.hwpx'));
    expect(blocks.map((b) => b.kind)).toEqual([
      'paragraph', 'paragraph', 'field', 'paragraph', 'paragraph',
      'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph',
      'table', 'paragraph', 'paragraph',
    ]);
    expect(paragraphs(blocks)[0]?.text).toBe('가나다구청');
  });

  it('글자가 없는 빈 문단은 블록으로 내보내지 않는다', () => {
    const blocks = extractBlocks(openFixture('notice.hwpx'));
    expect(paragraphs(blocks).every((b) => b.text.trim().length > 0)).toBe(true);
  });

  it('문단 번호 문단은 화면에 그려지는 번호 문자열을 함께 준다', () => {
    const numbered = paragraphs(extractBlocks(openFixture('notice.hwpx')))
      .filter((b) => b.number !== undefined)
      .map((b) => [b.number, b.text.split(':')[0]]);
    expect(numbered).toEqual([
      ['1.', '관련'],
      ['2.', '하반기 주민 안전교육을 아래와 같이 실시하오니 각 동 주민센터에서는 주민들이 참여할 수 있도록 안내하여 주시기 바랍니다.'],
      ['가.', '교육 대상'],
      ['나.', '교육 내용'],
      ['다.', '신청 방법'],
      ['3.', '회신 기한'],
    ]);
  });

  it('개요 문단은 번호와 개요 수준을 주고, 번호는 rhwp 개요 탐색 결과와 같다', () => {
    const doc = openFixture('outline-demo.hwpx');
    const outlined = paragraphs(extractBlocks(doc)).filter((b) => b.outlineLevel !== undefined);
    const navigation = z
      .object({ outline: z.array(z.object({ number: z.string(), level: z.number(), paragraph: z.number(), cellIndex: z.number().optional() })) })
      .parse(JSON.parse(doc.getOutlineNavigation()))
      .outline.filter((item) => item.cellIndex === undefined);
    expect(outlined.map((b) => [b.paragraph, b.number, b.outlineLevel])).toEqual(
      navigation.map((item) => [item.paragraph, item.number, item.level]),
    );
    expect(outlined.slice(0, 3).map((b) => b.number)).toEqual(['1.', '가.', '1)']);
  });

  it('표는 칸마다 행·열·텍스트와 같은 행 첫 칸 텍스트를 준다', () => {
    const [table] = tables(extractBlocks(openFixture('notice.hwpx')));
    expect(table?.rowCount).toBe(3);
    expect(table?.colCount).toBe(3);
    expect(table?.cells.find((c) => c.row === 2 && c.col === 2)).toEqual({
      row: 2,
      col: 2,
      text: '구민회관 소강당',
      rowLabel: '2회차',
    });
  });

  it('누름틀은 이름과 안내문을 준다', () => {
    const fields = extractBlocks(openFixture('application.hwpx')).filter((b) => b.kind === 'field');
    expect(fields.map((f) => [f.name, f.guide, f.paragraph])).toEqual([
      ['신청일', '신청일을 넣으세요', 4],
      ['신청인', '이름을 넣으세요', 5],
    ]);
  });

  it('.hwp(바이너리) 문서도 .hwpx 와 같은 블록을 뽑는다', () => {
    const fromHwp = extractBlocks(openFixture('notice.hwp'));
    const fromHwpx = extractBlocks(openFixture('notice.hwpx'));
    expect(fromHwp).toEqual(fromHwpx);
  });

  it('여러 쪽 문서에서 블록마다 쪽 번호를 준다', () => {
    const blocks = paragraphs(extractBlocks(openFixture('report.hwpx')));
    expect(blocks[0]?.page).toBe(1);
    expect(Math.max(...blocks.map((b) => b.page))).toBeGreaterThan(1);
  });
});
