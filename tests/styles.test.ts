// SPEC-003 스타일(#37, ADR 003): 문단 스타일 목록·이름으로 찾기·스타일 적용·제목 스타일(src/core/styles.ts).
// "(근거)" 테스트는 styles.ts 가 바로잡는 rhwp 0.8.7 의 지금 동작을 고정한다 — rhwp 를 올리면 먼저 깨진다.
// 도구(list_styles·set_style·insert_paragraph style)는 style-tools.test.ts.
import { HwpDocument } from '@rhwp/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractBlocks, type Block } from '../src/core/blocks.ts';
import { insertParagraphNear, replaceParagraphText } from '../src/core/edits.ts';
import { exportVerifiedHwpx } from '../src/core/hwpx-export.ts';
import { parseJson } from '../src/core/json.ts';
import { createBlankDocument } from '../src/core/rhwp-node.ts';
import { applyParagraphStyle, assertStylable, ensureTitleStyle, paragraphStyles, styleIdByName, TITLE_STYLE } from '../src/core/styles.ts';

const S = 0;

const paraPropsSchema = z.looseObject({ paraShapeId: z.number(), headType: z.string(), alignment: z.string() });
const charPropsSchema = z.looseObject({ fontSize: z.number(), bold: z.boolean() });
const styleAtSchema = z.object({ id: z.number(), name: z.string() });

const paraProps = (doc: HwpDocument, p: number) => parseJson(paraPropsSchema, doc.getParaPropertiesAt(S, p));
const charProps = (doc: HwpDocument, p: number, offset: number) => parseJson(charPropsSchema, doc.getCharPropertiesAt(S, p, offset));
const styleAt = (doc: HwpDocument, p: number) => parseJson(styleAtSchema, doc.getStyleAt(S, p)).name;

/** 문단 블록을 "번호 글자" 로(번호 없으면 글자만) */
const paragraphLines = (blocks: Block[]) =>
  blocks.flatMap((b) => (b.kind === 'paragraph' ? [b.number === undefined ? b.text : `${b.number} ${b.text}`] : []));

/** 문서 맨 끝 뒤로 [글자, 스타일 이름] 문단들을 차례로 넣는다 */
function writeParagraphs(doc: HwpDocument, lines: [string, string][]): void {
  let last = doc.getParagraphCount(S) - 1;
  for (const [text, style] of lines) {
    last = insertParagraphNear(doc, S, last, 'after', text);
    applyParagraphStyle(doc, S, last, styleIdByName(doc, style));
  }
}

/** SPEC-002 저장 검증: 내보내 다시 열어 블록이 같고 손실 보고가 없다. 다시 연 문서를 돌려준다 */
function expectSaveVerified(doc: HwpDocument): HwpDocument {
  const result = exportVerifiedHwpx(doc);
  expect(result.reopenError).toBeUndefined();
  expect(result.different).toEqual([]);
  expect(result.losses).toEqual([]);
  return new HwpDocument(result.bytes);
}

describe('SPEC-003 문단 스타일 목록 (paragraphStyles)', () => {
  it('AC-3 문단 스타일마다 이름·영문 이름과, 개요 스타일이면 개요 수준을 준다', () => {
    const styles = paragraphStyles(createBlankDocument());

    expect(styles.slice(0, 4)).toEqual([
      { id: 0, name: '바탕글', englishName: 'Normal' },
      { id: 1, name: '본문', englishName: 'Body' },
      { id: 2, name: '개요 1', englishName: 'Outline 1', outlineLevel: 1 },
      { id: 3, name: '개요 2', englishName: 'Outline 2', outlineLevel: 2 },
    ]);
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
});

describe('SPEC-003 제목 스타일', () => {
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

describe('SPEC-003 스타일 적용 (applyParagraphStyle)', () => {
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

  it('AC-4 없는 스타일 이름은 거부한다', () => {
    expect(() => styleIdByName(createBlankDocument(), '큰제목')).toThrow('없는 스타일입니다: 큰제목. list_styles 로 목록을 보세요.');
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
});

describe('SPEC-003 스타일 바꾸기 대상 (assertStylable)', () => {
  it('AC-5 문단 블록만 받고 표·누름틀 블록은 id 를 모아 거부한다', () => {
    const paragraph = { id: 'b1', anchor: { section: 0, paragraph: 1, part: 'text' } };
    expect(() => assertStylable([paragraph])).not.toThrow();

    expect(() =>
      assertStylable([
        paragraph,
        { id: 'b2', anchor: { section: 0, paragraph: 2, part: 'table:0' } },
        { id: 'b3', anchor: { section: 0, paragraph: 3, part: 'field:0' } },
      ]),
    ).toThrow('표·누름틀 블록은 스타일을 바꿀 수 없습니다: b2, b3. 문단 블록 id 를 주세요');
  });
});
