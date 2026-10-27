// SPEC-007 기술 검증(#62): 다른 문서 핸들에서 rhwp importParagraphBlock 으로 문단·번호 문단·표·그림 문단·스타일 문단을
// 서식째 가져오는지, HWPX 로 저장해 다시 열어도 같은지(ADR 004). 대안 exportSelectionHtml → pasteHtml 과 비교한다.
// 원본은 원본 탭이 보낼 HWPX 바이트(exportHwpx)에서 시작한다. "(근거)" 테스트는 어댑터(src/core/copy-paragraphs.ts)가
// 바로잡는 rhwp 0.8.7 의 지금 동작을 고정한다 — rhwp 를 올리면 먼저 깨진다.
import { HwpDocument } from '@rhwp/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractBlocks, type Block } from '../src/core/blocks.ts';
import { copyParagraphs, DEFAULT_SOURCES, type CopyResult } from '../src/core/copy-paragraphs.ts';
import { charLook } from '../src/core/edits.ts';
import { exportVerifiedHwpx } from '../src/core/hwpx-export.ts';
import { parseJson } from '../src/core/json.ts';
import { createBlankDocument } from '../src/core/rhwp-node.ts';
import { buildCopySource, ONE_PIXEL_PNG, SOURCE_ONLY_STYLE, SRC } from './copy-source.ts';
import { openFixture } from './fixtures.ts';

const S = 0;
const styleAtSchema = z.object({ id: z.number(), name: z.string() });
const styleListSchema = z.array(z.object({ id: z.number(), name: z.string() }));
const numberingListSchema = z.array(z.object({ id: z.number() }));
const paraLookSchema = z.looseObject({ paraShapeId: z.number(), numberingId: z.number(), borderFillId: z.number() });
const cellLookSchema = z.looseObject({ charShapeId: z.number(), borderFillId: z.number() });
const resourcesSchema = z.object({
  operationResult: z.object({ result: z.object({ resources: z.object({ added: z.number(), binariesAdded: z.number() }) }) }),
});

const importRequest = (start: number, end: number, before: number) =>
  JSON.stringify({ request: { sourceSection: S, sourceStart: start, sourceEnd: end, targetSection: S, insertBefore: before, count: 1 }, dryRun: false });

const styleAt = (doc: HwpDocument, p: number) => parseJson(styleAtSchema, doc.getStyleAt(S, p));
const styleNames = (doc: HwpDocument) => parseJson(styleListSchema, doc.getStyleList()).map(({ name }) => name);
const numberingCount = (doc: HwpDocument) => parseJson(numberingListSchema, doc.getNumberingList()).length;
/** 문단 모양 비교용: 보이는 속성. 모양·번호 정의·테두리 id(테두리는 값으로 들어 있다)와 번호 시작 방식(번호 정의 id 로 rhwp 가 계산한 값)은 뺀다 */
function paraLook(doc: HwpDocument, p: number): string {
  const { paraShapeId: _shape, numberingId: _numbering, numberingRestartMode: _mode, numberingStartNum: _start, borderFillId: _border, ...look } = parseJson(
    paraLookSchema,
    doc.getParaPropertiesAt(S, p),
  );
  return JSON.stringify(look);
}
const charLooks = (doc: HwpDocument, p: number) => Array.from({ length: doc.getParagraphLength(S, p) }, (_, i) => charLook(doc, S, p, i));
function cellLook(doc: HwpDocument, p: number, cell: number): string {
  const { charShapeId: _id, borderFillId: _border, ...look } = parseJson(cellLookSchema, doc.getCellCharPropertiesAt(S, p, 0, cell, 0, 0));
  return JSON.stringify(look);
}
const text = (doc: HwpDocument, p: number) => doc.getTextRange(S, p, 0, doc.getParagraphLength(S, p));
/** 문단 블록은 "번호 글자", 표는 칸 글자 */
const outlineOf = (blocks: Block[]) =>
  blocks.map((b) => {
    if (b.kind === 'paragraph') return b.number === undefined ? b.text : `${b.number} ${b.text}`;
    if (b.kind === 'table') return `표 ${b.cells.map((c) => c.text).join('|')}`;
    return `${b.kind} ${b.name}`;
  });

function copied(result: CopyResult) {
  if (!result.ok) throw new Error(`복사가 거부됐다: ${JSON.stringify(result.rejected)}`);
  return result;
}

/** SPEC-002 저장 검증: 내보내 다시 열어 블록이 같고 손실 보고가 없다. 다시 연 문서를 돌려준다 */
function expectSaveVerified(doc: HwpDocument): HwpDocument {
  const result = exportVerifiedHwpx(doc);
  expect(result.reopenError).toBeUndefined();
  expect(result.different).toEqual([]);
  expect(result.losses).toEqual([]);
  return new HwpDocument(result.bytes);
}

describe('SPEC-007 문서 사이 복사 — rhwp importParagraphBlock 동작 (기술 검증)', () => {
  it('원본 HWPX 바이트를 그대로 연 핸들은 번호 문단·누름틀 문단을 거부한다 (근거)', () => {
    const source = new HwpDocument(buildCopySource().exportHwpx());
    const target = openFixture('report.hwpx');

    expect(() => target.importParagraphBlock(source, importRequest(SRC.numbered.start, SRC.numbered.start + 1, 2))).toThrow(
      'opaque HWPX paraHead import is not supported',
    );
    expect(() => target.importParagraphBlock(source, importRequest(SRC.field, SRC.field + 1, 2))).toThrow('unvalidated field parameters');
  });

  it('HWP 로 한 번 바꾼 핸들은 번호·누름틀 문단도 받지만, 같은 이름 스타일과 번호 정의를 복제해 더한다 (근거)', () => {
    const target = openFixture('notice.hwpx');
    const before = { styles: styleNames(target).length, numberings: numberingCount(target) };
    const source = DEFAULT_SOURCES[0]?.(buildCopySource().exportHwpx());
    if (source === undefined) throw new Error('원본 핸들이 없다');

    // 대상과 원본이 같은 공문인데도 HWP 왕복으로 모양 값이 달라져 바탕글·번호 정의가 새로 생긴다
    target.importParagraphBlock(source, importRequest(SRC.numbered.start, SRC.numbered.end, 6));

    expect(styleNames(target).length).toBe(before.styles + 1);
    expect(styleNames(target).filter((name) => name === '바탕글')).toHaveLength(2);
    expect(styleAt(target, 6)).toEqual({ id: before.styles, name: '바탕글' });
    expect(numberingCount(target)).toBe(before.numberings + 1);
    // 번호는 번호 정의마다 따로 센다(rhwp NumberingState) → 가져온 문단이 1. 부터 다시, 대상 번호도 끊긴다
    expect(outlineOf(extractBlocks(target)).filter((line) => /^\d\. /.test(line)).map((line) => line.slice(0, 6))).toEqual([
      '1. 관련:', '1. 관련:', '2. 하반기', '3. 회신 ', '2. 하반기', '3. 회신 ',
    ]);
  });

  it('개요 문단은 원본 구역 개요 번호를 복제한 번호 정의를 받아 대상 개요와 따로 센다 (근거)', () => {
    const target = openFixture('outline-demo.hwpx');
    const source = new HwpDocument(openFixture('report.hwpx').exportHwp());

    target.importParagraphBlock(source, importRequest(7, 9, 2)); // "1. 이용 현황" + "가. 3분기…"

    expect(outlineOf(extractBlocks(target)).slice(0, 3)).toEqual(['1. 총칙', '1. 이용 현황', expect.stringMatching(/^가\. 3분기/)]);
    expect(parseJson(paraLookSchema, target.getParaPropertiesAt(S, 2)).numberingId).toBe(2);
  });

  it('스타일·모양은 번호(id)가 아니라 내용으로 맞춘다 — 대상의 같은 번호에 다른 스타일이 있어도 섞이지 않는다 (근거)', () => {
    const target = openFixture('report.hwpx');
    const other = target.createStyle(JSON.stringify({ name: '다른 스타일', englishName: 'Other', type: 0, nextStyleId: 0 }));
    const sourceDoc = buildCopySource();
    // 원본 "강조 문단" 과 대상 "다른 스타일" 이 같은 번호다
    expect(styleAt(sourceDoc, SRC.sourceStyle).id).toBe(other);
    const source = new HwpDocument(sourceDoc.exportHwp());

    target.importParagraphBlock(source, importRequest(SRC.sourceStyle, SRC.sourceStyle + 1, 2));

    expect(styleAt(target, 2).name).toBe(SOURCE_ONLY_STYLE.name);
    expect(styleAt(target, 2).id).not.toBe(other);
    expect(charLooks(target, 2)).toEqual(charLooks(sourceDoc, SRC.sourceStyle));
    expect(paraLook(target, 2)).toBe(paraLook(sourceDoc, SRC.sourceStyle));
  });

  it('그림 문단은 그림 바이너리째 가져온다 (근거)', () => {
    const target = openFixture('report.hwpx');
    const source = new HwpDocument(buildCopySource().exportHwp());

    const result = parseJson(resourcesSchema, target.importParagraphBlock(source, importRequest(SRC.picture, SRC.picture + 1, 2)));

    expect(result.operationResult.result.resources.binariesAdded).toBe(1);
    expect(target.getControlImageMime(S, 2, '', 0)).toBe('image/png');
    expect(target.getControlImageData(S, 2, '', 0)).toEqual(ONE_PIXEL_PNG);
  });

  it('rhwp deleteStyle 은 본문 문단만 바탕글로 돌리고 표 칸 문단의 스타일 번호는 그대로 둔다 (근거)', () => {
    const target = openFixture('report.hwpx');
    const duplicate = styleNames(target).length;
    target.importParagraphBlock(new HwpDocument(buildCopySource().exportHwp()), importRequest(SRC.table, SRC.table + 1, 2));
    expect(parseJson(styleAtSchema, target.getCellStyleAt(S, 2, 0, 0, 0))).toEqual({ id: duplicate, name: '바탕글' });

    target.deleteStyle(duplicate);

    expect(styleAt(target, 2)).toEqual({ id: 0, name: '바탕글' });
    // 칸 문단은 없는 스타일 번호를 가리킨다(그래서 어댑터는 칸 문단을 먼저 applyCellStyle 로 옮기고 지운다)
    expect(parseJson(styleAtSchema, target.getCellStyleAt(S, 2, 0, 0, 0))).toEqual({ id: duplicate, name: '' });
  });

  it('각주가 든 문단은 블록째 거부한다 — 일부 개체만 빼고 가져오지 않는다 (근거)', () => {
    const doc = createBlankDocument();
    doc.insertText(S, 0, 0, '첫째');
    doc.splitParagraph(S, 0, 2);
    doc.insertText(S, 1, 0, '각주 문단');
    doc.insertFootnote(S, 1, 2);
    const target = openFixture('report.hwpx');
    const before = Array.from({ length: target.getParagraphCount(S) }, (_, p) => text(target, p));

    expect(copyParagraphs(target, doc.exportHwpx(), { section: S, start: 1, end: 2 }, { section: S, before: 2 })).toEqual({
      ok: false,
      rejected: [{ paragraph: 1, reason: '각주' }],
    });
    expect(Array.from({ length: target.getParagraphCount(S) }, (_, p) => text(target, p))).toEqual(before);
  });
});

describe('SPEC-007 문서 사이 복사 — copyParagraphs 보정 (기술 검증)', () => {
  const source = buildCopySource();
  const sourceBytes = source.exportHwpx();
  const ALL = { section: S, start: SRC.numbered.start, end: SRC.outlineStyle + 1 };

  it('AC-5 문단·번호 문단·표·그림 문단·스타일 문단을 글자·문단 모양째 다른 문서에 넣고, 원본은 그대로다', () => {
    const target = openFixture('report.hwpx');
    const sourceBefore = outlineOf(extractBlocks(source));

    const { inserted } = copied(copyParagraphs(target, sourceBytes, ALL, { section: S, before: 2 }));

    expect(inserted).toEqual({ start: 2, end: 2 + ALL.end - ALL.start });
    for (let i = 0; i < ALL.end - ALL.start; i += 1) {
      const [from, to] = [ALL.start + i, inserted.start + i];
      expect(text(target, to)).toBe(text(source, from));
      expect(charLooks(target, to)).toEqual(charLooks(source, from));
      expect(paraLook(target, to)).toBe(paraLook(source, from));
    }
    const table = inserted.start + SRC.table - ALL.start;
    for (let cell = 0; cell < 9; cell += 1) expect(cellLook(target, table, cell)).toBe(cellLook(source, SRC.table, cell));
    expect(target.getControlImageData(S, inserted.start + SRC.picture - ALL.start, '', 0)).toEqual(ONE_PIXEL_PNG);
    // 번호 문단은 대상에 같은 모양 번호가 없어 새 목록(1. 부터), 개요 스타일 문단은 대상 개요를 따라 "1." 이고 대상 "개요" 가 "2." 로 밀린다
    expect(outlineOf(extractBlocks(target)).slice(1, 14).map((line) => line.slice(0, 8))).toEqual([
      '1. 관련: 가', '2. 하반기 주', '가. 교육 대상', '나. 교육 내용', '다. 신청 방법', '3. 회신 기한',
      '표 구분|일정|', '붙임  교육 신', '가나다구청장', '그림 문단', '강조 스타일 문', '1. 개요 스타', '2. 개요',
    ]);
    expect(outlineOf(extractBlocks(source))).toEqual(sourceBefore);
  });

  it('대상에 같은 모양의 번호 정의가 있으면 그 번호를 쓰고, 번호가 대상 위치를 따라 다시 매겨진다', () => {
    const target = openFixture('notice.hwpx');

    // "3. 회신 기한" 을 대상 "2. 하반기…" 앞에
    const { corrections } = copied(copyParagraphs(target, sourceBytes, { section: S, start: 10, end: 11 }, { section: S, before: 6 }));

    expect(corrections.numbering).toBe(1);
    expect(outlineOf(extractBlocks(target)).filter((line) => /^\d\. /.test(line)).map((line) => line.slice(0, 6))).toEqual([
      '1. 관련:', '2. 회신 ', '3. 하반기', '4. 회신 ',
    ]);
  });

  it('대상에 같은 모양의 번호 정의가 없으면 새 번호 목록(1부터)으로 들어간다', () => {
    const target = openFixture('report.hwpx');

    copied(copyParagraphs(target, sourceBytes, { section: S, ...SRC.numbered }, { section: S, before: 2 }));

    expect(outlineOf(extractBlocks(target)).slice(1, 8).map((line) => line.slice(0, 3))).toEqual(['1. ', '2. ', '가. ', '나. ', '다. ', '3. ', '1. ']);
  });

  it('개요 문단은 대상 구역 개요 번호를 따라 이어지고 뒤 개요 번호도 다시 매겨진다', () => {
    const target = openFixture('outline-demo.hwpx');

    copied(copyParagraphs(target, sourceBytes, { section: S, start: SRC.outlineStyle, end: SRC.outlineStyle + 1 }, { section: S, before: 4 }));

    // 대상: 1. 총칙 / 총칙 설명 / 총칙 보충 / 가. 목적 … → "개요 스타일 문단" 을 "가. 목적" 앞(문단 4)에
    expect(outlineOf(extractBlocks(target)).slice(0, 5).map((line) => line.slice(0, 8))).toEqual([
      '1. 총칙', '총칙 설명 문단', '총칙 보충 문단', '2. 개요 스타', '가. 목적',
    ]);
  });

  it('대상에 같은 이름 스타일이 있으면 그 스타일이 되고, 복제 스타일("바탕글" 두 개 등)은 남지 않는다', () => {
    const target = openFixture('report.hwpx');
    const before = styleNames(target);

    const { inserted, corrections } = copied(copyParagraphs(target, sourceBytes, ALL, { section: S, before: 2 }));

    expect(corrections.deletedStyles).toEqual(['바탕글', '개요 1']);
    expect(styleNames(target)).toEqual([...before, SOURCE_ONLY_STYLE.name]);
    expect(styleAt(target, inserted.start)).toEqual({ id: 0, name: '바탕글' });
    expect(styleAt(target, inserted.end - 1)).toEqual({ id: 2, name: '개요 1' });
    const table = inserted.start + SRC.table - ALL.start;
    expect(parseJson(styleAtSchema, target.getCellStyleAt(S, table, 0, 4, 0))).toEqual({ id: 0, name: '바탕글' });
  });

  it('표 칸 문단이 원본에만 있는 스타일을 쓰면 복제 스타일을 지우지 않고 한글처럼 "이름 사본N" 으로 바꾼다', () => {
    const sourceDoc = buildCopySource();
    sourceDoc.applyCellStyle(S, SRC.table, 0, 0, 0, styleAt(sourceDoc, SRC.sourceStyle).id); // 칸 "구분" 에 "강조 문단"
    const target = openFixture('report.hwpx');
    const before = styleNames(target);

    const { inserted, corrections } = copied(
      copyParagraphs(target, sourceDoc.exportHwpx(), { section: S, start: SRC.table, end: SRC.table + 1 }, { section: S, before: 2 }),
    );

    // 지우면 deleteStyle 이 칸 문단 번호를 당기지 않아 "강조 문단" 칸이 엉뚱한 번호를 가리킨다
    expect(corrections.deletedStyles).toEqual([]);
    expect(corrections.renamedStyles).toEqual(['바탕글 → 바탕글 사본1']);
    expect(styleNames(target)).toEqual([...before, '바탕글 사본1', SOURCE_ONLY_STYLE.name]);
    expect(parseJson(styleAtSchema, target.getCellStyleAt(S, inserted.start, 0, 0, 0)).name).toBe(SOURCE_ONLY_STYLE.name);
    expect(parseJson(styleAtSchema, target.getCellStyleAt(S, inserted.start, 0, 1, 0))).toEqual({ id: 0, name: '바탕글' });
    expect(styleNames(expectSaveVerified(target))).toEqual(styleNames(target));
  });

  it('AC-6 대상에 같은 이름 스타일이 없으면 원본 스타일 이름·모양 그대로 더해진다', () => {
    const target = openFixture('application.hwpx');
    const at = SRC.sourceStyle - ALL.start;

    const { inserted, corrections } = copied(copyParagraphs(target, sourceBytes, ALL, { section: S, before: 2 }));

    expect(corrections.addedStyles).toEqual([SOURCE_ONLY_STYLE.name]);
    expect(styleAt(target, inserted.start + at).name).toBe(SOURCE_ONLY_STYLE.name);
    expect(charLooks(target, inserted.start + at)).toEqual(charLooks(source, SRC.sourceStyle));
    expect(paraLook(target, inserted.start + at)).toBe(paraLook(source, SRC.sourceStyle));
  });

  it('같은 이름 스타일의 모양이 대상과 다르면 스타일 모양이던 글자는 대상 스타일을, 직접 서식은 원본을 따른다', () => {
    const target = openFixture('report.hwpx');
    target.updateStyleShapes(0, JSON.stringify({ fontSize: 1200 }), '{}'); // 대상 바탕글 = 12pt

    const { inserted } = copied(copyParagraphs(target, sourceBytes, { section: S, start: 6, end: SRC.signature + 1 }, { section: S, before: 2 }));

    const size = (p: number) => z.looseObject({ fontSize: z.number(), bold: z.boolean() }).parse(JSON.parse(target.getCharPropertiesAt(S, p, 0)));
    expect(size(inserted.start)).toMatchObject({ fontSize: 1200, bold: false }); // 원본 10pt 바탕글 문단
    expect(size(inserted.end - 1)).toMatchObject({ fontSize: 1800, bold: true }); // 원본 직접 서식 "가나다구청장"
  });

  it('HWPX 로 저장해 다시 열어도 글자·문단 모양·스타일·번호·표·그림이 같다', () => {
    const target = openFixture('report.hwpx');
    const { inserted } = copied(copyParagraphs(target, sourceBytes, ALL, { section: S, before: 2 }));

    const reopened = expectSaveVerified(target);

    expect(outlineOf(extractBlocks(reopened))).toEqual(outlineOf(extractBlocks(target)));
    expect(styleNames(reopened)).toEqual(styleNames(target));
    for (let p = inserted.start; p < inserted.end; p += 1) {
      expect(styleAt(reopened, p)).toEqual(styleAt(target, p));
      expect(charLooks(reopened, p)).toEqual(charLooks(target, p));
      expect(paraLook(reopened, p)).toBe(paraLook(target, p));
    }
    expect(reopened.getControlImageData(S, inserted.start + SRC.picture - ALL.start, '', 0)).toEqual(ONE_PIXEL_PNG);
  });

  it('AC-5 스냅샷 하나로 되돌리면 넣은 문단과 더한 스타일·번호 정의·그림까지 모두 돌아간다', () => {
    const target = openFixture('report.hwpx');
    const before = { outline: outlineOf(extractBlocks(target)), styles: styleNames(target), numberings: numberingCount(target) };
    const snapshot = target.saveSnapshot();
    copied(copyParagraphs(target, sourceBytes, ALL, { section: S, before: 2 }));

    target.restoreSnapshot(snapshot);

    expect(outlineOf(extractBlocks(target))).toEqual(before.outline);
    expect(styleNames(target)).toEqual(before.styles);
    expect(numberingCount(target)).toBe(before.numberings);
    expect(expectSaveVerified(target).getParagraphCount(S)).toBe(target.getParagraphCount(S));
  });

  it('구역 첫 문단 앞에는 넣지 않고, 원본 구역 첫 문단은 구역·단 시작 문단으로 거부한다', () => {
    const target = openFixture('report.hwpx');

    expect(() => copyParagraphs(target, sourceBytes, { section: S, ...SRC.numbered }, { section: S, before: 0 })).toThrow(
      '구역 첫 문단 앞에는 넣을 수 없습니다.',
    );
    expect(copyParagraphs(target, sourceBytes, { section: S, start: 0, end: 1 }, { section: S, before: 2 })).toEqual({
      ok: false,
      rejected: [{ paragraph: 0, reason: '구역·단 시작 문단' }],
    });
  });
});

describe('SPEC-007 문서 사이 복사 — 대안 exportSelectionHtml → pasteHtml (기술 검증)', () => {
  it('글자 크기·굵게·정렬은 남지만 번호·표·그림·스타일을 잃는다 (근거)', () => {
    const source = buildCopySource();
    const target = openFixture('report.hwpx');
    const tablesBefore = extractBlocks(target).filter((b) => b.kind === 'table').length;
    const end = SRC.sourceStyle;
    const html = source.exportSelectionHtml(S, SRC.numbered.start, 0, end, source.getParagraphLength(S, end));

    expect(html).not.toContain('<table');
    expect(html).not.toContain('<img');
    target.pasteHtml(S, 1, 0, html);

    const blocks = extractBlocks(target);
    const pasted = blocks.filter((b) => b.kind === 'paragraph' && b.text.includes('관련: 가나다구청'));
    expect(pasted).toHaveLength(1);
    expect(pasted[0]?.kind === 'paragraph' && pasted[0].number).toBeFalsy();
    expect(blocks.filter((b) => b.kind === 'table')).toHaveLength(tablesBefore);
    const signature = Array.from({ length: target.getParagraphCount(S) }, (_, p) => p).find((p) => text(target, p).includes('가나다구청장'));
    if (signature === undefined) throw new Error('붙인 서명 문단이 없다');
    expect(charLook(target, S, signature, text(target, signature).indexOf('가'))).toBe(charLook(source, S, SRC.signature, 0));
    const emphasis = Array.from({ length: target.getParagraphCount(S) }, (_, p) => p).find((p) => text(target, p).includes('강조 스타일 문단'));
    if (emphasis === undefined) throw new Error('붙인 스타일 문단이 없다');
    expect(styleAt(target, emphasis).name).toBe('바탕글');
  });
});
