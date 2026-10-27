import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { extractBlocks, numbersForParagraphs, numbersFromLayout, type Block, type LayoutRun, type ParagraphBlock, type TableBlock } from '../src/core/blocks.ts';
import { listFields } from '../src/core/fields.ts';
import { findInBlocks } from '../src/core/find-text.ts';
import { createBlankDocument } from '../src/core/rhwp-node.ts';
import { openFixture } from './fixtures.ts';

const S = 0;
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

  it('번호 문단 가운데 누름틀이 있어도 번호 문자열은 번호 글자다', () => {
    const doc = createBlankDocument();
    doc.insertText(0, 0, 0, '수신  귀하');
    const numberingId = doc.ensureDefaultNumbering();
    doc.applyParaFormat(0, 0, JSON.stringify({ headType: 'Number', paraLevel: 0, numberingId }));
    doc.insertClickHereField(0, 0, 4, '받는 곳', '', '수신', true);

    const [first] = paragraphs(extractBlocks(doc));
    expect(first?.number).toBe('1.');
  });

  it('다음 쪽으로 이어지는 번호 문단 앞에 머리말이 그려져도 번호는 첫 쪽의 번호 글자다', () => {
    // 1쪽: 번호 "3." 다음에 문단 5 첫 줄. 2쪽: 머리말(문단 위치 없음) 다음에 문단 5 이어지는 줄
    const numbers = numbersFromLayout([
      [
        { text: '3.' },
        { text: '회신 기한: 2026. 11. 14.', secIdx: 0, paraIdx: 5, charStart: 0 },
      ],
      [
        { text: '가나다구청 안내' },
        { text: '까지 회신하여 주시기 바랍니다.', secIdx: 0, paraIdx: 5, charStart: 30 },
      ],
    ]);
    expect(numbers.get('0:5')).toBe('3.');
  });

  it('문단 첫 줄이 아닌 줄 앞의 글자는 번호로 보지 않는다', () => {
    // 쪽 머리에서 시작하는 이어지는 줄만 있고, 그 앞에 쪽 번호가 그려진 경우
    const numbers = numbersFromLayout([
      [
        { text: '- 2 -' },
        { text: '이어지는 줄', secIdx: 0, paraIdx: 7, charStart: 12 },
      ],
    ]);
    expect(numbers.has('0:7')).toBe(false);
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

  it('SPEC-005 누름틀은 값이 든 글자 블록(문단 text·표 칸 text) 안 자리를 준다', () => {
    const doc = openFixture('application.hwpx');
    const applicant = listFields(doc).find((field) => field.name === '신청인');
    if (applicant === undefined) throw new Error('신청인 누름틀이 없다');
    doc.setFieldValue(applicant.fieldId, '홍길동');

    const blocks = extractBlocks(doc);
    const field = blocks.find((b) => b.kind === 'field' && b.name === '신청인');
    const paragraph = paragraphs(blocks).find((b) => b.paragraph === 5);

    expect(field?.kind === 'field' ? field.span : undefined).toEqual({ start: 5, end: 8 });
    expect([...(paragraph?.text ?? '')].slice(5, 8).join('')).toBe('홍길동');
  });

  it('SPEC-005 표 칸 안 누름틀의 자리는 칸 text(칸 안 문단을 \\n 으로 이은 것) 안 위치다', () => {
    const doc = openFixture('notice.hwpx');
    // b12 표(문단 11, 컨트롤 0)의 (1,1) 칸 "11. 20.(목) 14:00" 은 칸 번호 4. 둘째 문단 첫 자리에 누름틀을 넣는다
    doc.splitParagraphInCell(S, 11, 0, 4, 0, 4);
    doc.insertClickHereFieldInCell(S, 11, 0, 4, 1, 0, false, '입력', '', '칸 누름틀', true);
    const cellField = listFields(doc).find((field) => field.name === '칸 누름틀');
    if (cellField === undefined) throw new Error('칸 누름틀이 없다');
    doc.setFieldValue(cellField.fieldId, 'XY');

    const blocks = extractBlocks(doc);
    const field = blocks.find((b) => b.kind === 'field' && b.name === '칸 누름틀');
    const table = blocks.find((b) => b.kind === 'table');
    const cellText = table?.kind === 'table' ? table.cells.find((c) => c.row === 1 && c.col === 1)?.text : undefined;

    expect(cellText).toBe('11. \nXY20.(목) 14:00');
    expect(field?.kind === 'field' ? field.span : undefined).toEqual({ cell: { controlIndex: 0, row: 1, col: 1 }, start: 5, end: 7 });
  });

  it('.hwp(바이너리) 문서도 .hwpx 와 같은 블록을 뽑는다', () => {
    const fromHwp = extractBlocks(openFixture('notice.hwp'));
    const fromHwpx = extractBlocks(openFixture('notice.hwpx'));
    expect(fromHwp).toEqual(fromHwpx);
  });

  it('번호 문단이 없는 문서는 쪽 글자 배치를 읽지 않는다', () => {
    const doc = openFixture('application.hwpx');
    const layout = vi.spyOn(doc, 'getPageTextLayout');

    const blocks = paragraphs(extractBlocks(doc));

    expect(blocks.some((b) => b.number !== undefined)).toBe(false);
    expect(layout).not.toHaveBeenCalled();
  });

  it('쪽 글자 배치는 번호·개요 문단이 시작하는 쪽만 읽는다', () => {
    const doc = createBlankDocument();
    doc.insertText(0, 0, 0, '번호 없는 첫 문단');
    doc.splitParagraph(0, 0, doc.getParagraphLength(0, 0));
    doc.insertText(0, 1, 0, '둘째 쪽 번호 문단');
    doc.insertPageBreak(0, 1, 0);
    const numberingId = doc.ensureDefaultNumbering();
    const last = doc.getParagraphCount(0) - 1;
    doc.applyParaFormat(0, last, JSON.stringify({ headType: 'Number', paraLevel: 0, numberingId }));
    const layout = vi.spyOn(doc, 'getPageTextLayout');

    const blocks = paragraphs(extractBlocks(doc));

    expect(doc.pageCount()).toBe(2);
    expect(blocks.map((b) => [b.page, b.number])).toEqual([
      [1, undefined],
      [2, '1.'],
    ]);
    expect(layout.mock.calls).toEqual([[1]]);
  });

  it('번호가 문단 시작 쪽이 아니라 다음 쪽에 그려졌으면 다음 쪽에서 찾는다', () => {
    // 쪽 나눔으로 시작하는 문단은 시작 위치(getPageOfPosition)가 앞 쪽인데 번호는 다음 쪽 머리에 그려진다
    const pages: LayoutRun[][] = [
      [{ text: '앞 문단', secIdx: 0, paraIdx: 0, charStart: 0 }],
      [
        { text: '2.' },
        { text: '쪽 나눔 뒤 번호 문단', secIdx: 0, paraIdx: 1, charStart: 0 },
      ],
      [{ text: '셋째 쪽', secIdx: 0, paraIdx: 2, charStart: 0 }],
    ];
    const read: number[] = [];

    const numbers = numbersForParagraphs([{ key: '0:1', page: 0 }], pages.length, (page) => {
      read.push(page);
      return pages[page] ?? [];
    });

    expect(numbers.get('0:1')).toBe('2.');
    expect(read).toEqual([0, 1]);
  });

  it('시작 쪽에서 번호를 찾으면 다음 쪽은 읽지 않고, 같은 쪽은 한 번만 읽는다', () => {
    const pages: LayoutRun[][] = [
      [
        { text: '1.' },
        { text: '첫 번호 문단', secIdx: 0, paraIdx: 0, charStart: 0 },
        { text: '2.' },
        { text: '둘째 번호 문단', secIdx: 0, paraIdx: 1, charStart: 0 },
      ],
      [{ text: '다음 쪽', secIdx: 0, paraIdx: 2, charStart: 0 }],
    ];
    const read: number[] = [];

    const numbers = numbersForParagraphs(
      [
        { key: '0:0', page: 0 },
        { key: '0:1', page: 0 },
      ],
      pages.length,
      (page) => {
        read.push(page);
        return pages[page] ?? [];
      },
    );

    expect([...numbers]).toEqual([
      ['0:0', '1.'],
      ['0:1', '2.'],
    ]);
    expect(read).toEqual([0]);
  });

  it('구역 나누기 표식이 든 문단 뒤의 표도 실제 구역·문단 위치로 찾는다', () => {
    // getSectionStarts 는 구역 정의(SectionDef) 표식 기준이라 구역이 하나여도 [0, 1] 을 준다.
    // 표 위치(getControls 의 para)는 실제 구역의 문단 수를 이어 붙인 번호라 그것으로 나누면 안 된다
    const doc = createBlankDocument();
    doc.insertText(0, 0, 0, '첫 문단입니다');
    doc.splitParagraph(0, 0, 7);
    doc.insertText(0, 1, 0, '둘째 문단');
    doc.breakAtCursor(0, 1, 0, 'section');
    doc.createTable(0, doc.getParagraphCount(0) - 1, 0, 2, 2);

    expect(doc.getSectionCount()).toBe(1);
    expect(doc.getSectionStarts()).toBe('[0,1]');
    expect(tables(extractBlocks(doc)).map((t) => [t.section, t.paragraph])).toEqual([[0, 2]]);
  });

  it('머리말·꼬리말·각주는 블록으로 내보내지 않고 찾기에도 나오지 않는다', () => {
    const doc = createBlankDocument();
    doc.insertText(0, 0, 0, '본문 문단');
    doc.createHeaderFooter(0, true, 0);
    doc.insertTextInHeaderFooter(0, true, 0, 0, 0, '머리말 글자');
    doc.createHeaderFooter(0, false, 0);
    doc.insertTextInHeaderFooter(0, false, 0, 0, 0, '꼬리말 글자');
    const footnote = z.object({ controlIdx: z.number() }).parse(JSON.parse(doc.insertFootnote(0, 0, 2)));
    doc.insertTextInFootnote(0, 0, footnote.controlIdx, 0, 0, '각주 글자');

    const blocks = extractBlocks(doc);

    expect(blocks.map((b) => (b.kind === 'paragraph' ? b.text : b.kind))).toEqual(['본문 문단']);
    expect(findInBlocks(blocks, '글자')).toEqual([]);
  });

  it('여러 쪽 문서에서 블록마다 쪽 번호를 준다', () => {
    const blocks = paragraphs(extractBlocks(openFixture('report.hwpx')));
    expect(blocks[0]?.page).toBe(1);
    expect(Math.max(...blocks.map((b) => b.page))).toBeGreaterThan(1);
  });
});
