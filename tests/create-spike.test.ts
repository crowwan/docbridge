// SPEC-003 기술 검증(#35): rhwp 빈 문서 템플릿·스타일 적용·표 만들기·양식 본문 비우기가 스펙대로 되는지(ADR 003).
// "(근거)" 테스트는 어댑터(src/core/create-document.ts)가 바로잡는 rhwp 0.8.7 의 지금 동작을 고정한다 — rhwp 를 올리면 먼저 깨진다.
import { HwpDocument } from '@rhwp/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractBlocks, type Block } from '../src/core/blocks.ts';
import {
  applyParagraphStyle,
  bodyTextLength,
  clearTemplateBody,
  ensureTitleStyle,
  insertTableParagraph,
  isHeaderCell,
  paragraphStyles,
  styleIdByName,
  TITLE_STYLE,
} from '../src/core/create-document.ts';
import { insertParagraphNear, replaceParagraphText } from '../src/core/edits.ts';
import { exportVerifiedHwpx } from '../src/core/hwpx-export.ts';
import { parseJson } from '../src/core/json.ts';
import { createBlankDocument } from '../src/core/rhwp-node.ts';
import { openFixture } from './fixtures.ts';

const S = 0;

const paraPropsSchema = z.looseObject({ paraShapeId: z.number(), headType: z.string(), alignment: z.string() });
const charPropsSchema = z.looseObject({ fontSize: z.number(), bold: z.boolean(), textColor: z.string() });
/** 양식·앞 문단의 직접 글자 서식(22pt 굵게 빨강) */
const LOUD = JSON.stringify({ bold: true, fontSize: 2200, textColor: '#ff0000' });
const NORMAL_LOOK = { fontSize: 1000, bold: false, textColor: '#000000' };
const paragraphTexts = (doc: HwpDocument) =>
  Array.from({ length: doc.getParagraphCount(S) }, (_, p) => doc.getTextRange(S, p, 0, doc.getParagraphLength(S, p)));
const styleAtSchema = z.object({ id: z.number(), name: z.string() });
const tablePropsSchema = z.looseObject({ repeatHeader: z.boolean() });
const cellWidthSchema = z.looseObject({ width: z.number() });
const pageDefSchema = z.looseObject({ width: z.number(), marginLeft: z.number(), marginRight: z.number() });
const headerFooterSchema = z.looseObject({ exists: z.boolean(), text: z.string().optional() });

const paraProps = (doc: HwpDocument, p: number) => parseJson(paraPropsSchema, doc.getParaPropertiesAt(S, p));
const charProps = (doc: HwpDocument, p: number, offset: number) => parseJson(charPropsSchema, doc.getCharPropertiesAt(S, p, offset));
const cellCharProps = (doc: HwpDocument, table: { paragraph: number; controlIndex: number }, cell: number) =>
  parseJson(charPropsSchema, doc.getCellCharPropertiesAt(S, table.paragraph, table.controlIndex, cell, 0, 0));
const styleAt = (doc: HwpDocument, p: number) => parseJson(styleAtSchema, doc.getStyleAt(S, p)).name;
const headerText = (doc: HwpDocument, isHeader: boolean) => parseJson(headerFooterSchema, doc.getHeaderFooter(S, isHeader, 0));

/** 문단 블록을 "번호 글자" 로(번호 없으면 글자만) */
const paragraphLines = (blocks: Block[]) =>
  blocks.flatMap((b) => (b.kind === 'paragraph' ? [b.number === undefined ? b.text : `${b.number} ${b.text}`] : []));

/** 문서 맨 끝 뒤로 [글자, 스타일 이름] 문단들을 차례로 넣는다(insert_paragraph + style 이 할 일). 마지막 문단 번호를 돌려준다 */
function writeParagraphs(doc: HwpDocument, lines: [string, string][]): number {
  let last = doc.getParagraphCount(S) - 1;
  for (const [text, style] of lines) {
    last = insertParagraphNear(doc, S, last, 'after', text);
    applyParagraphStyle(doc, S, last, styleIdByName(doc, style));
  }
  return last;
}

/** SPEC-002 저장 검증: 내보내 다시 열어 블록이 같고 손실 보고가 없다. 다시 연 문서를 돌려준다 */
function expectSaveVerified(doc: HwpDocument): HwpDocument {
  const result = exportVerifiedHwpx(doc);
  expect(result.reopenError).toBeUndefined();
  expect(result.different).toEqual([]);
  expect(result.losses).toEqual([]);
  return new HwpDocument(result.bytes);
}

describe('SPEC-003 빈 문서 템플릿 (기술 검증)', () => {
  it('빈 문서의 문단 스타일은 바탕글·본문·개요 1~10 등이고 "제목"은 없다 (근거)', () => {
    const styles = paragraphStyles(createBlankDocument());

    expect(styles.map(({ name }) => name)).toEqual([
      '바탕글', '본문', '개요 1', '개요 2', '개요 3', '개요 4', '개요 5', '개요 6', '개요 7', '개요 8', '개요 9', '개요 10',
      '머리말', '각주', '미주', '메모', '차례 제목', '차례 1', '차례 2', '차례 3', '캡션',
    ]);
    // 글자 스타일 "쪽 번호" 는 문단 스타일 목록에 없다
    expect(styles.some(({ name }) => name === '쪽 번호')).toBe(false);
    expect(styles.filter(({ outlineLevel }) => outlineLevel !== undefined).map(({ name, outlineLevel }) => `${name}:${outlineLevel}`)).toEqual(
      Array.from({ length: 10 }, (_, i) => `개요 ${i + 1}:${i + 1}`),
    );
  });

  it('"개요 1" 이라도 스타일 문단 모양에 개요가 없으면 개요 스타일로 보지 않고 번호도 붙지 않는다', () => {
    const doc = createBlankDocument();
    // 한컴 공문 양식에서 본 모양: 개요 스타일을 번호 없는 문단 모양으로 바꿔 쓴다(로컬 한컴 기안문)
    doc.updateStyleShapes(styleIdByName(doc, '개요 1'), '{}', JSON.stringify({ headType: 'None' }));

    expect(paragraphStyles(doc).find(({ name }) => name === '개요 1')).toEqual({ id: 2, name: '개요 1', englishName: 'Outline 1' });
    writeParagraphs(doc, [['배경', '개요 1']]);
    expect(paragraphLines(extractBlocks(doc))).toEqual(['배경']);
  });

  it('스타일 종류 값에 다른 비트가 섞인 문단 스타일(한컴 HWP 5 바이너리)도 문단 스타일로 본다', () => {
    const doc = createBlankDocument();
    // 한컴 HWP 5 바이너리 일부는 "본문"·"개요 1" 등의 종류 값이 4·108 로 온다. createStyle 이 종류 값을 그대로 둬서 재현한다
    doc.createStyle(JSON.stringify({ name: '옛 문단', englishName: 'Old', type: 108, nextStyleId: 0 }));

    expect(paragraphStyles(doc).some(({ name }) => name === '옛 문단')).toBe(true);
  });

  it('스타일 종류 값의 글자 스타일 비트가 켜진 스타일(다른 비트가 섞인 109 등)은 문단 스타일 목록에서 뺀다', () => {
    const doc = createBlankDocument();
    doc.createStyle(JSON.stringify({ name: '옛 글자', englishName: 'OldChar', type: 109, nextStyleId: 0 }));

    expect(paragraphStyles(doc).some(({ name }) => name === '옛 글자')).toBe(false);
    expect(() => styleIdByName(doc, '옛 글자')).toThrow('없는 스타일입니다: 옛 글자');
  });

  it('빈 문서는 구역·단 정의가 든 빈 문단 하나라 블록이 없고, 첫 문단을 빈 문단 블록으로 남기면 채울 수 있다', () => {
    const doc = createBlankDocument();
    expect(doc.getParagraphCount(S)).toBe(1);
    expect(extractBlocks(doc)).toEqual([]);

    const start = extractBlocks(doc, (section, paragraph) => section === S && paragraph === 0);
    expect(start).toEqual([{ kind: 'paragraph', section: S, paragraph: 0, page: 1, text: '' }]);

    replaceParagraphText(doc, S, 0, 'DocBridge 도입 제안서');
    expect(paragraphLines(extractBlocks(doc))).toEqual(['DocBridge 도입 제안서']);
  });

  it('개요 스타일 문단은 개요 번호를 받고 본문 스타일 문단은 받지 않는다', () => {
    const doc = createBlankDocument();
    writeParagraphs(doc, [
      ['제안 배경', '개요 1'],
      ['한글 문서를 채팅에서 다룬다.', '본문'],
      ['현황', '개요 2'],
      ['문제', '개요 2'],
      ['기대 효과', '개요 1'],
    ]);

    const blocks = extractBlocks(doc);
    expect(paragraphLines(blocks)).toEqual(['1. 제안 배경', '한글 문서를 채팅에서 다룬다.', '가. 현황', '나. 문제', '2. 기대 효과']);
    expect(blocks.flatMap((b) => (b.kind === 'paragraph' ? [b.outlineLevel ?? 0] : []))).toEqual([1, 0, 2, 2, 1]);
  });

  it('스타일·개요·표를 넣은 빈 문서가 HWPX 저장 검증을 통과하고 다시 열어도 스타일 이름이 그대로다', () => {
    const doc = createBlankDocument();
    const title = ensureTitleStyle(doc);
    replaceParagraphText(doc, S, 0, '제안서');
    applyParagraphStyle(doc, S, 0, title);
    const last = writeParagraphs(doc, [['배경', '개요 1'], ['본문 글', '본문']]);
    insertTableParagraph(doc, S, last, 'after', { rows: 2, cols: 2, cells: [['항목', '내용'], ['기간', '3개월']], header: true });

    const reopened = expectSaveVerified(doc);
    expect([0, 1, 2].map((p) => styleAt(reopened, p))).toEqual(['제목', '개요 1', '본문']);
  });
});

describe('SPEC-003 제목 스타일 (기술 검증)', () => {
  it('제목 스타일이 없으면 가운데 정렬 20pt 굵게로 만들고, 있으면 다시 만들지 않는다', () => {
    const doc = createBlankDocument();
    const before = paragraphStyles(doc).length;

    const id = ensureTitleStyle(doc);
    expect(ensureTitleStyle(doc)).toBe(id);
    expect(paragraphStyles(doc)).toHaveLength(before + 1);
    expect(styleIdByName(doc, '제목')).toBe(id);
    expect(styleIdByName(doc, 'Title')).toBe(id);

    replaceParagraphText(doc, S, 0, '제안서');
    applyParagraphStyle(doc, S, 0, id);
    expect(charProps(doc, 0, 0)).toMatchObject({ fontSize: TITLE_STYLE.fontSize, bold: true });
    expect(paraProps(doc, 0)).toMatchObject({ alignment: 'center', headType: 'None' });
    // 다른 스타일의 모양은 바뀌지 않는다
    insertParagraphNear(doc, S, 0, 'after', '본문');
    applyParagraphStyle(doc, S, 1, styleIdByName(doc, '본문'));
    expect(charProps(doc, 1, 0)).toMatchObject({ fontSize: 1000, bold: false });

    const reopened = expectSaveVerified(doc);
    expect(styleAt(reopened, 0)).toBe('제목');
    expect(charProps(reopened, 0, 0)).toMatchObject({ fontSize: TITLE_STYLE.fontSize, bold: true });
  });
});

describe('SPEC-003 제목 스타일 실패·중복 (기술 검증)', () => {
  it('모양을 정하지 못하면 만든 제목 스타일을 지우고, 다음 호출은 모양이 있는 제목 스타일을 만든다', () => {
    const doc = createBlankDocument();
    const before = paragraphStyles(doc).length;
    const update = doc.updateStyleShapes.bind(doc);
    doc.updateStyleShapes = () => false;

    expect(() => ensureTitleStyle(doc)).toThrow('제목 스타일의 모양을 정하지 못했습니다.');
    expect(paragraphStyles(doc)).toHaveLength(before);

    doc.updateStyleShapes = update;
    const id = ensureTitleStyle(doc);
    replaceParagraphText(doc, S, 0, '제안서');
    applyParagraphStyle(doc, S, 0, id);
    expect(charProps(doc, 0, 0)).toMatchObject({ fontSize: TITLE_STYLE.fontSize, bold: true });
  });

  it('영문 이름이 Title 인 스타일이 다른 한글 이름으로 있으면 그것을 쓰고 새로 만들지 않는다', () => {
    const doc = createBlankDocument();
    const existing = doc.createStyle(JSON.stringify({ name: '표제', englishName: 'Title', type: 0, nextStyleId: 1 }));
    const before = paragraphStyles(doc).length;

    expect(ensureTitleStyle(doc)).toBe(existing);
    expect(paragraphStyles(doc)).toHaveLength(before);
  });
});

describe('SPEC-003 스타일 적용 (기술 검증)', () => {
  /** 바탕글 문단 셋: "맨 앞" / "가나다라마바" / "뒤 문단" */
  function threeParagraphs(): HwpDocument {
    const doc = createBlankDocument();
    replaceParagraphText(doc, S, 0, '맨 앞');
    insertParagraphNear(doc, S, 0, 'after', '가나다라마바');
    insertParagraphNear(doc, S, 1, 'after', '뒤 문단');
    return doc;
  }

  it('rhwp applyStyle 은 직접 문단 모양이 있는 문단의 문단 모양을 바꾸지 않아 개요 번호가 안 붙는다 (근거)', () => {
    const doc = threeParagraphs();
    doc.applyParaFormat(S, 1, JSON.stringify({ alignment: 'center' }));

    doc.applyStyle(S, 1, styleIdByName(doc, '개요 1'));

    expect(styleAt(doc, 1)).toBe('개요 1');
    expect(paraProps(doc, 1)).toMatchObject({ headType: 'None', alignment: 'center' });
  });

  it('직접 문단 모양이 있던 문단도 스타일의 문단 모양을 받아 개요 번호가 붙는다', () => {
    const doc = threeParagraphs();
    doc.applyParaFormat(S, 1, JSON.stringify({ alignment: 'center' }));

    applyParagraphStyle(doc, S, 1, styleIdByName(doc, '개요 1'));

    expect(paraProps(doc, 1)).toMatchObject({ headType: 'Outline', alignment: 'justify' });
    expect(paragraphLines(extractBlocks(doc))).toEqual(['맨 앞', '1. 가나다라마바', '뒤 문단']);
  });

  it('직접 글자 서식(굵게)은 남고 나머지 글자는 스타일 글자 모양을 받는다', () => {
    const doc = threeParagraphs();
    doc.applyCharFormat(S, 1, 2, 4, JSON.stringify({ bold: true }));

    applyParagraphStyle(doc, S, 1, styleIdByName(doc, '차례 제목'));

    // 차례 제목 = 16pt. 굵게 건 "다라" 는 직접 서식이라 굵기·크기(10pt)가 그대로 남는다(rhwp 동작)
    expect([0, 2, 3, 4].map((offset) => charProps(doc, 1, offset))).toMatchObject([
      { fontSize: 1600, bold: false },
      { fontSize: 1000, bold: true },
      { fontSize: 1000, bold: true },
      { fontSize: 1600, bold: false },
    ]);
  });

  it('개요 문단을 본문으로 바꾸면 번호가 사라지고, 개요 2 를 개요 1 로 바꾸면 수준이 바뀐다', () => {
    const doc = threeParagraphs();
    applyParagraphStyle(doc, S, 1, styleIdByName(doc, '개요 2'));
    expect(paragraphLines(extractBlocks(doc))[1]).toBe('가. 가나다라마바');

    applyParagraphStyle(doc, S, 1, styleIdByName(doc, '개요 1'));
    expect(paragraphLines(extractBlocks(doc))[1]).toBe('1. 가나다라마바');

    applyParagraphStyle(doc, S, 1, styleIdByName(doc, '본문'));
    expect(paragraphLines(extractBlocks(doc))[1]).toBe('가나다라마바');
  });

  it('없는 스타일 이름은 거부한다', () => {
    expect(() => styleIdByName(createBlankDocument(), '큰제목')).toThrow('없는 스타일입니다: 큰제목. list_styles 로 목록을 보세요.');
  });
});

describe('SPEC-003 표 만들기 (기술 검증)', () => {
  /** "배경"(개요 1) 다음 "목표"(개요 1) */
  function outlineDocument(): HwpDocument {
    const doc = createBlankDocument();
    replaceParagraphText(doc, S, 0, '제목');
    writeParagraphs(doc, [['배경', '개요 1'], ['목표', '개요 1']]);
    return doc;
  }

  it('rhwp createTable 은 개요 문단 모양을 표 문단·칸·표 아래 빈 문단에 물려줘 뒤 개요 번호가 밀린다 (근거)', () => {
    const doc = outlineDocument();
    doc.insertParagraph(S, 2);

    doc.createTable(S, 2, 0, 2, 2);

    expect(doc.getParagraphCount(S)).toBe(5); // 표 문단 + 표 아래 빈 문단
    expect([2, 3].map((p) => paraProps(doc, p).headType)).toEqual(['Outline', 'Outline']);
    expect(paragraphLines(extractBlocks(doc))).toEqual(['제목', '1. 배경', '7. 목표']);
  });

  it('개요 문단 뒤에 넣은 표는 개요 번호를 받지 않고, 새 문단은 표가 든 문단 하나다', () => {
    const doc = outlineDocument();

    const table = insertTableParagraph(doc, S, 1, 'after', { rows: 2, cols: 2 });

    expect(table).toEqual({ paragraph: 2, controlIndex: 0 });
    expect(doc.getParagraphCount(S)).toBe(4);
    expect(paraProps(doc, 2).headType).toBe('None');
    expect(paragraphLines(extractBlocks(doc))).toEqual(['제목', '1. 배경', '2. 목표']);
    expect(extractBlocks(doc).map((b) => b.kind)).toEqual(['paragraph', 'paragraph', 'table', 'paragraph']);
  });

  it('표 너비는 쪽 본문 너비를 열 수로 똑같이 나눈다', () => {
    const doc = outlineDocument();
    const page = parseJson(pageDefSchema, doc.getPageDef(S));

    const table = insertTableParagraph(doc, S, 1, 'after', { rows: 1, cols: 3 });

    // rhwp 는 바깥 여백 283 × 2 를 빼고 나눈다(A4: 59528 − 8504 × 2 − 566 = 41954)
    const content = page.width - page.marginLeft - page.marginRight - 566;
    const widths = [0, 1, 2].map((cell) => parseJson(cellWidthSchema, doc.getCellProperties(S, table.paragraph, table.controlIndex, cell)).width);
    expect(widths).toEqual([0, 1, 2].map(() => Math.floor(content / 3)));
  });

  it('칸 글자를 채우고, 칸 글자의 줄바꿈은 칸 안 문단으로 나눈다', () => {
    const doc = outlineDocument();

    const table = insertTableParagraph(doc, S, 1, 'after', {
      rows: 3,
      cols: 2,
      cells: [['항목', '내용'], ['목표', '첫 줄\n둘째 줄'], ['기간', '3개월']],
    });

    expect(doc.getCellParagraphCount(S, table.paragraph, table.controlIndex, 3)).toBe(2);
    const block = extractBlocks(doc).find((b) => b.kind === 'table');
    expect(block?.kind === 'table' ? block.cells.map(({ text }) => text) : []).toEqual(['항목', '내용', '목표', '첫 줄\n둘째 줄', '기간', '3개월']);
  });

  it('머리글 행은 제목 셀·머리글 반복·굵은 글자로 표현하고 HWPX 로 저장해 다시 열어도 남는다', () => {
    const doc = outlineDocument();

    const table = insertTableParagraph(doc, S, 1, 'after', { rows: 2, cols: 2, cells: [['항목', '내용'], ['기간', '3개월']], header: true });

    const check = (target: HwpDocument) => {
      expect([0, 1, 2, 3].map((cell) => isHeaderCell(target, S, table.paragraph, table.controlIndex, cell))).toEqual([true, true, false, false]);
      expect(parseJson(tablePropsSchema, target.getTableProperties(S, table.paragraph, table.controlIndex)).repeatHeader).toBe(true);
      expect([0, 1, 2].map((cell) => cellCharProps(target, table, cell).bold)).toEqual([true, true, false]);
    };
    check(doc);
    check(expectSaveVerified(doc));
  });

  it('기준 문단 앞에도 넣고, 구역 첫 문단 앞은 거부한다', () => {
    const doc = outlineDocument();

    const table = insertTableParagraph(doc, S, 2, 'before', { rows: 1, cols: 1, cells: [['앞 표']] });

    expect(table.paragraph).toBe(2);
    expect(extractBlocks(doc).map((b) => (b.kind === 'paragraph' ? b.text : b.kind))).toEqual(['제목', '배경', 'table', '목표']);
    expect(() => insertTableParagraph(doc, S, 0, 'before', { rows: 1, cols: 1 })).toThrow('구역 첫 문단 앞에는 표를 넣을 수 없습니다');
  });

  it('rhwp 가 표 아래 빈 문단을 붙이지 않으면 뒤 문단을 지우지 않는다', () => {
    const doc = outlineDocument();
    const create = doc.createTable.bind(doc);
    // 표 아래 빈 문단을 붙이지 않는 rhwp 를 흉내낸다
    doc.createTable = (section, paragraph, offset, rows, cols) => {
      const result = create(section, paragraph, offset, rows, cols);
      doc.deleteParagraph(section, paragraph + 1);
      return result;
    };

    insertTableParagraph(doc, S, 1, 'after', { rows: 1, cols: 1 });

    expect(paragraphTexts(doc)).toEqual(['제목', '배경', '', '목표']);
  });

  it('표가 예상한 문단에 들어가지 않으면 거부하고 넣은 문단·표를 되돌린다', () => {
    const doc = outlineDocument();
    const before = paragraphTexts(doc);
    const create = doc.createTable.bind(doc);
    doc.createTable = (section, paragraph, offset, rows, cols) => {
      create(section, paragraph, offset, rows, cols);
      return JSON.stringify({ ok: true, paraIdx: paragraph + 5, controlIdx: 0 });
    };

    expect(() => insertTableParagraph(doc, S, 1, 'after', { rows: 1, cols: 1 })).toThrow('표가 예상한 문단');
    expect(paragraphTexts(doc)).toEqual(before);
    expect(extractBlocks(doc).some((b) => b.kind === 'table')).toBe(false);
  });

  it('앞 문단 끝 글자의 직접 서식이 표 문단·칸 글자로 번지지 않는다', () => {
    const doc = outlineDocument();
    doc.applyCharFormat(S, 1, 0, doc.getParagraphLength(S, 1), LOUD);

    const table = insertTableParagraph(doc, S, 1, 'after', { rows: 2, cols: 1, cells: [['머리'], ['칸']], header: true });

    expect(cellCharProps(doc, table, 1)).toMatchObject(NORMAL_LOOK);
    expect(cellCharProps(doc, table, 0)).toMatchObject({ ...NORMAL_LOOK, bold: true });
  });

  it('행·열이 1~50 밖이거나 cells 크기가 다르면 거부한다', () => {
    const doc = outlineDocument();
    const count = doc.getParagraphCount(S);

    expect(() => insertTableParagraph(doc, S, 1, 'after', { rows: 0, cols: 2 })).toThrow('표 크기는 행·열 1~50 입니다');
    expect(() => insertTableParagraph(doc, S, 1, 'after', { rows: 2, cols: 51 })).toThrow('표 크기는 행·열 1~50 입니다');
    expect(() => insertTableParagraph(doc, S, 1, 'after', { rows: 2, cols: 2, cells: [['a', 'b'], ['c']] })).toThrow('cells 크기가 2×2 와 다릅니다.');
    expect(doc.getParagraphCount(S)).toBe(count);
  });
});

describe('SPEC-003 양식 본문 비우기 (기술 검증)', () => {
  it.each(['notice.hwpx', 'report.hwpx', 'application.hwpx', 'notice.hwp'])(
    '%s 를 양식으로 비우면 구역 첫 문단만 남고 스타일·쪽 설정은 그대로이며 저장 검증을 통과한다',
    (name) => {
      const doc = openFixture(name);
      const styles = doc.getStyleList();
      const pageDef = doc.getPageDef(S);

      const cleared = clearTemplateBody(doc);

      expect(cleared.keptParagraphs).toEqual([{ section: S, paragraph: 0 }]);
      expect(cleared.keptObjects).toMatchObject({ '구역 정의': 1, '단 정의': 1 });
      expect(cleared.removedObjects['표']).toBeGreaterThan(0);
      expect(doc.getParagraphCount(S)).toBe(1);
      expect(bodyTextLength(doc)).toBe(0);
      expect(extractBlocks(doc)).toEqual([]);
      expect(doc.getStyleList()).toBe(styles);
      expect(doc.getPageDef(S)).toBe(pageDef);
      expectSaveVerified(doc);
    },
  );

  it('머리말·꼬리말은 남기고, 비운 첫 문단은 바탕글이 된다', () => {
    const doc = openFixture('report.hwpx');
    doc.createHeaderFooter(S, true, 0);
    doc.insertTextInHeaderFooter(S, true, 0, 0, 0, '가나다구청 보고서');
    doc.createHeaderFooter(S, false, 0);
    doc.insertTextInHeaderFooter(S, false, 0, 0, 0, '대외비');
    doc.applyParaFormat(S, 0, JSON.stringify({ alignment: 'center' }));

    const cleared = clearTemplateBody(doc);

    expect(cleared.keptObjects).toMatchObject({ 머리말: 1, 꼬리말: 1 });
    expect(styleAt(doc, 0)).toBe('바탕글');
    expect(paraProps(doc, 0).alignment).toBe('justify');
    const reopened = expectSaveVerified(doc);
    expect(headerText(reopened, true)).toMatchObject({ exists: true, text: '가나다구청 보고서' });
    expect(headerText(reopened, false)).toMatchObject({ exists: true, text: '대외비' });
  });

  it('비운 첫 문단은 양식의 직접 글자 서식을 버리고 바탕글 글자 모양이 되어, 제목은 20pt 로 이어 넣는 문단은 바탕글로 나온다', () => {
    // 한컴 양식처럼 구역 첫 문단이 스타일 밖 글자 모양(22pt 굵게 빨강)을 가진 빈 문단이다(로컬 한컴 문서는 첫 문단 글자 모양이 바탕글 것과 달랐다)
    const doc = createBlankDocument();
    doc.insertText(S, 0, 0, '표지');
    doc.applyCharFormat(S, 0, 0, 2, LOUD);
    const loud = parseJson(z.looseObject({ charShapeId: z.number() }), doc.getCharPropertiesAt(S, 0, 0)).charShapeId;
    doc.deleteText(S, 0, 0, 2);
    doc.setCharShapeId(S, 0, 0, 0, loud);
    insertParagraphNear(doc, S, 0, 'after', '양식 본문');

    clearTemplateBody(doc);
    replaceParagraphText(doc, S, 0, '새 제목');
    expect(charProps(doc, 0, 0)).toMatchObject(NORMAL_LOOK);

    applyParagraphStyle(doc, S, 0, ensureTitleStyle(doc));
    expect(charProps(doc, 0, 0)).toMatchObject({ fontSize: TITLE_STYLE.fontSize, bold: true, textColor: '#000000' });
  });

  it('본문 첫 문단 안의 표·누름틀도 지운다', () => {
    const doc = createBlankDocument();
    replaceParagraphText(doc, S, 0, '첫 문단 글자');
    doc.createTableEx(JSON.stringify({ sectionIdx: S, paraIdx: 0, charOffset: 2, rowCount: 1, colCount: 1, treatAsChar: true }));
    expect(extractBlocks(doc).some((b) => b.kind === 'table' && b.paragraph === 0)).toBe(true);

    const cleared = clearTemplateBody(doc);

    expect(cleared.removedObjects).toEqual({ 표: 1 });
    expect(doc.getParagraphCount(S)).toBe(1);
    expect(extractBlocks(doc)).toEqual([]);
    expectSaveVerified(doc);
  });

  it('비운 양식에 제목·개요·본문·표를 채운 문서가 저장 검증을 통과한다', () => {
    const doc = openFixture('notice.hwpx');
    clearTemplateBody(doc);
    const title = ensureTitleStyle(doc);
    replaceParagraphText(doc, S, 0, '하반기 사업 계획');
    applyParagraphStyle(doc, S, 0, title);
    const last = writeParagraphs(doc, [['추진 배경', '개요 1'], ['세부 내용', '개요 2'], ['본문입니다.', '본문']]);
    insertTableParagraph(doc, S, last, 'after', { rows: 3, cols: 2, cells: [['구분', '내용'], ['기간', '7~12월'], ['예산', '1억']], header: true });

    expect(paragraphLines(extractBlocks(doc))).toEqual(['하반기 사업 계획', '1. 추진 배경', '가. 세부 내용', '본문입니다.']);
    expectSaveVerified(doc);
  });
});
