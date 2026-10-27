// SPEC-002 기술 검증(#18): rhwp 편집 API 로 옮기기·바꾸기·넣기·되돌리기·HWPX 저장 검증이 스펙대로 되는지.
// 측정(시간·메모리)은 시간에 기대지 않게 테스트가 아니라 scripts/measure-edits.ts 로 잰다.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HwpDocument } from '@rhwp/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BlockIdTable } from '../src/core/block-ids.ts';
import { extractBlocks, type Block } from '../src/core/blocks.ts';
import { EditHistory, UNDO_LIMIT } from '../src/core/edit-history.ts';
import {
  charLook,
  insertParagraphNear,
  listFields,
  moveParagraphs,
  moveRejectReason,
  replaceCellText,
  replaceFieldText,
  replaceParagraphText,
} from '../src/core/edits.ts';
import { differentBlocks, exportVerifiedHwpx } from '../src/core/hwpx-export.ts';
import { createBlankDocument, openDocumentFile } from '../src/core/rhwp-node.ts';
import { openFixture } from './fixtures.ts';

const S = 0;

const textOf = (doc: HwpDocument, paragraph: number) => doc.getTextRange(S, paragraph, 0, doc.getParagraphLength(S, paragraph));
const paragraphTexts = (doc: HwpDocument) =>
  Array.from({ length: doc.getParagraphCount(S) }, (_, p) => textOf(doc, p));
const paraShapeId = (doc: HwpDocument, paragraph: number): unknown => JSON.parse(doc.getParaPropertiesAt(S, paragraph)).paraShapeId;
const charShapeIdAt = (doc: HwpDocument, paragraph: number, offset: number): unknown =>
  JSON.parse(doc.getCharPropertiesAt(S, paragraph, offset)).charShapeId;

/** 문단 블록의 "번호 글자" 목록 (번호 없는 문단 제외) */
const numbered = (blocks: Block[]) =>
  blocks.flatMap((b) => (b.kind === 'paragraph' && b.number !== undefined ? [`${b.number} ${b.text.slice(0, 6)}`] : []));

function paragraphIndex(doc: HwpDocument, startsWith: string): number {
  const index = paragraphTexts(doc).findIndex((text) => text.startsWith(startsWith));
  if (index < 0) throw new Error(`"${startsWith}" 로 시작하는 문단이 없다`);
  return index;
}

/** createTable 결과 {"ok":true,"paraIdx":N,"controlIdx":N} → 표 자리 */
const createdTable = (result: string) => {
  const { paraIdx, controlIdx } = z.object({ paraIdx: z.number(), controlIdx: z.number() }).parse(JSON.parse(result));
  return { paragraph: paraIdx, control: controlIdx };
};

/** "가나다라마바" 에서 "다라" 만 굵게 한 빈 문서 */
function mixedDocument(): HwpDocument {
  const doc = createBlankDocument();
  doc.insertText(S, 0, 0, '가나다라마바');
  doc.applyCharFormat(S, 0, 2, 4, JSON.stringify({ bold: true }));
  return doc;
}

describe('SPEC-002 문단 옮기기 (기술 검증)', () => {
  it('자동 번호 문단을 옮기면 번호가 새 순서로 다시 매겨지고 문단 모양이 그대로다', () => {
    const doc = openFixture('notice.hwpx');
    const reply = paragraphIndex(doc, '회신 기한');
    const related = paragraphIndex(doc, '관련:');
    const shape = paraShapeId(doc, reply);
    const look = charLook(doc, S, reply, 0);

    const result = moveParagraphs(doc, S, reply, reply + 1, related);

    expect(result).toEqual({ ok: true, moved: { start: related, end: related + 1 } });
    expect(numbered(extractBlocks(doc)).filter((n) => /^\d/.test(n))).toEqual(['1. 회신 기한:', '2. 관련: 가나', '3. 하반기 주민']);
    expect(paraShapeId(doc, related)).toBe(shape);
    expect(charLook(doc, S, related, 0)).toBe(look);
  });

  it('이어진 개요 문단 여러 개를 하위 문단째 옮긴다', () => {
    const doc = openFixture('report.hwpx');
    const before = paragraphTexts(doc);
    const plan = paragraphIndex(doc, '개선 과제');
    const future = paragraphIndex(doc, '향후 계획');
    const usage = paragraphIndex(doc, '이용 현황');

    const result = moveParagraphs(doc, S, plan, future, usage);

    expect(result.ok).toBe(true);
    const tops = numbered(extractBlocks(doc)).filter((n) => /^\d/.test(n));
    expect(tops).toEqual(['1. 개요', '2. 개선 과제', '3. 이용 현황', '4. 분기별 비교', '5. 향후 계획']);
    // 글자는 그대로 다른 순서
    expect([...paragraphTexts(doc)].sort()).toEqual([...before].sort());
  });

  it('뒤로 옮길 때와 맨 끝으로 옮길 때도 원래 문단을 지운다', () => {
    const doc = openFixture('notice.hwpx');
    const count = doc.getParagraphCount(S);
    const related = paragraphIndex(doc, '관련:');

    expect(moveParagraphs(doc, S, related, related + 1, count)).toEqual({ ok: true, moved: { start: count - 1, end: count } });
    expect(doc.getParagraphCount(S)).toBe(count);
    expect(textOf(doc, count - 1)).toMatch(/^관련:/);
    expect(paragraphTexts(doc).filter((t) => t.startsWith('관련:'))).toHaveLength(1);
  });

  it('표가 든 문단과 누름틀이 든 문단도 옮긴다', () => {
    const doc = openFixture('application.hwpx');
    const blocks = extractBlocks(doc);
    const table = blocks.find((b) => b.kind === 'table');
    const applicant = paragraphIndex(doc, '신청인');
    if (table === undefined) throw new Error('표가 없다');

    expect(moveParagraphs(doc, S, applicant, applicant + 1, table.paragraph).ok).toBe(true);

    const after = extractBlocks(doc);
    expect(after.find((b) => b.kind === 'field' && b.name === '신청인')?.paragraph).toBe(table.paragraph);
    expect(after.find((b) => b.kind === 'table')?.paragraph).toBe(table.paragraph + 1);
  });

  it('각주·새 번호·책갈피가 든 문단은 아무것도 바꾸지 않고 문단과 이유를 모두 돌려준다', () => {
    const doc = createBlankDocument();
    doc.insertText(S, 0, 0, '첫째');
    ['둘째', '셋째 각주', '넷째 새 번호', '다섯째 책갈피'].forEach((text, i) => {
      doc.splitParagraph(S, i, doc.getParagraphLength(S, i));
      doc.insertText(S, i + 1, 0, text);
    });
    doc.addBookmark(S, 4, 2, '책갈피1');
    doc.insertFootnote(S, 2, 2);
    doc.insertNewNumber(S, 3, 2, 5);
    const before = paragraphTexts(doc);

    const result = moveParagraphs(doc, S, 2, 5, 1);

    expect(result).toEqual({
      ok: false,
      rejected: [
        { paragraph: 2, reason: '각주' },
        { paragraph: 3, reason: '새 번호로 시작' },
        { paragraph: 4, reason: '책갈피' },
      ],
    });
    expect(paragraphTexts(doc)).toEqual(before);
  });

  it('구역 첫 문단(구역·단 정의가 든 문단)은 옮기지 않고, 그 앞으로도 옮기지 않는다', () => {
    const doc = openFixture('notice.hwpx');
    const related = paragraphIndex(doc, '관련:');

    expect(moveParagraphs(doc, S, 0, 1, related)).toEqual({ ok: false, rejected: [{ paragraph: 0, reason: '구역·단 시작 문단' }] });
    expect(() => moveParagraphs(doc, S, related, related + 1, 0)).toThrow('구역 첫 문단 앞으로는 옮길 수 없습니다.');
  });

  it('rhwp 는 구역 첫 문단 앞에 넣은 문단 뒤에 구역 정의를 남긴다 (근거)', () => {
    const doc = openFixture('notice.hwpx');
    const source = new HwpDocument(doc.exportHwp());
    doc.importParagraphBlock(
      source,
      JSON.stringify({ request: { sourceSection: S, sourceStart: 5, sourceEnd: 6, targetSection: S, insertBefore: 0, count: 1 }, dryRun: false }),
    );
    const sectionDef = z.array(z.object({ ctrlId: z.string(), para: z.number() })).parse(JSON.parse(doc.getControls())).find((c) => c.ctrlId === 'secd');
    expect(sectionDef?.para).toBe(1);
  });

  // 한컴이 저장한 그리기 개체는 rhwp 로 만들 수 없어서, 레포에 넣지 않은 로컬 한컴 문서가 있을 때만 돈다(ADR 001·002)
  const realHwpx01 = join(process.env.DOCBRIDGE_EXTRA_FIXTURES_DIR ?? '', 'real-hwpx-01.hwpx');
  it.runIf(process.env.DOCBRIDGE_EXTRA_FIXTURES_DIR !== undefined && existsSync(realHwpx01))(
    '한컴 HWPX 의 그리기 개체 문단은 HWP 사본에서 거부되면 HWPX 사본으로 옮긴다 (로컬 한컴 문서)',
    () => {
      const doc = openDocumentFile(realHwpx01);
      const drawing = 29; // 그리기 개체(gso) 하나만 든 문단
      const viaHwp = new HwpDocument(doc.exportHwp());
      const request = JSON.stringify({ request: { sourceSection: S, sourceStart: drawing, sourceEnd: drawing + 1, targetSection: S, insertBefore: 1, count: 1 }, dryRun: true });
      expect(() => doc.importParagraphBlock(viaHwp, request)).toThrow('uninterpreted CTRL_DATA payload');

      expect(moveParagraphs(doc, S, drawing, drawing + 1, 1)).toEqual({ ok: true, moved: { start: 1, end: 2 } });
    },
  );

  it('rhwp HWPX 사본은 번호 문단을 거부해서 HWP 사본을 먼저 쓴다 (근거)', () => {
    const doc = openFixture('notice.hwpx');
    const reply = paragraphIndex(doc, '회신 기한');
    const viaHwpx = new HwpDocument(doc.exportHwpx());
    const request = JSON.stringify({ request: { sourceSection: S, sourceStart: reply, sourceEnd: reply + 1, targetSection: S, insertBefore: 5, count: 1 }, dryRun: true });
    expect(() => doc.importParagraphBlock(viaHwpx, request)).toThrow('opaque HWPX paraHead import is not supported');
  });

  it('되돌릴 문단 모양은 사본이 아니라 원본 문서에서 읽는다 (PR #24 리뷰)', () => {
    const doc = openFixture('notice.hwpx');
    const reply = paragraphIndex(doc, '회신 기한');
    const related = paragraphIndex(doc, '관련:');
    const shape = paraShapeId(doc, reply);
    // 왕복하며 문단 모양 번호가 달라진 사본을 흉내낸다: 사본의 그 문단만 다른 모양 번호
    const shiftedCopy = (d: HwpDocument) => {
      const copy = new HwpDocument(d.exportHwp());
      copy.setParaShapeId(S, reply, paraShapeId(d, 0) === shape ? 1 : 0);
      return copy;
    };

    expect(moveParagraphs(doc, S, reply, reply + 1, related, [shiftedCopy]).ok).toBe(true);
    expect(paraShapeId(doc, related)).toBe(shape);
  });

  it('사본의 문단 수나 옮길 문단 글자가 원본과 다르면 다음 사본으로, 모두 다르면 아무것도 바꾸지 않고 거부한다 (PR #24 리뷰)', () => {
    const doc = openFixture('notice.hwpx');
    const before = paragraphTexts(doc);
    const reply = paragraphIndex(doc, '회신 기한');
    const related = paragraphIndex(doc, '관련:');
    const otherDocument = () => openFixture('report.hwpx');
    const changedText = (d: HwpDocument) => {
      const copy = new HwpDocument(d.exportHwp());
      copy.insertText(S, reply, 0, '다른 ');
      return copy;
    };

    const rejected = moveParagraphs(doc, S, reply, reply + 1, related, [otherDocument, changedText]);
    expect(rejected).toEqual({ ok: false, rejected: [{ paragraph: reply, reason: '문서 사본이 원본과 달라 옮길 수 없습니다' }] });
    expect(paragraphTexts(doc)).toEqual(before);

    expect(moveParagraphs(doc, S, reply, reply + 1, related, [otherDocument, (d) => new HwpDocument(d.exportHwp())]).ok).toBe(true);
  });

  it('사본 만들기가 실패하면 다음 사본을 시도하고, 모두 실패하면 거부한다 (PR #24 리뷰)', () => {
    const doc = openFixture('notice.hwpx');
    const reply = paragraphIndex(doc, '회신 기한');
    const related = paragraphIndex(doc, '관련:');
    const broken = (): HwpDocument => {
      throw new Error('사본 실패');
    };

    expect(moveParagraphs(doc, S, reply, reply + 1, related, [broken, (d) => new HwpDocument(d.exportHwp())]).ok).toBe(true);
    expect(moveParagraphs(doc, S, related + 1, related + 2, related, [broken])).toEqual({
      ok: false,
      rejected: [{ paragraph: related + 1, reason: '문서 사본을 만들지 못했습니다: 사본 실패' }],
    });
  });

  it('rhwp 거부 문구에서 이유를 읽고, 모르는 이유는 그대로 둔다', () => {
    expect(moveRejectReason('렌더링 오류: paragraph block: source: paragraph block unsupported at [Paragraph(0), Control(0)]: Footnote')).toBe('각주');
    expect(moveRejectReason('렌더링 오류: paragraph block: source: paragraph block unsupported at [Paragraph(2)]: Something')).toBe('Something');
  });

  it('기준 문단이 옮길 문단 안이나 바로 옆이면 거부한다', () => {
    const doc = openFixture('notice.hwpx');
    expect(() => moveParagraphs(doc, S, 5, 7, 6)).toThrow('기준 문단이 옮길 문단 안이나 바로 옆에 있습니다.');
    expect(() => moveParagraphs(doc, S, 5, 7, 7)).toThrow('기준 문단이 옮길 문단 안이나 바로 옆에 있습니다.');
  });

  it('옮긴 뒤 블록 id 표를 옮기면 모든 id 가 같은 내용을 가리킨다', () => {
    const doc = openFixture('notice.hwpx');
    const before = extractBlocks(doc);
    const ids = BlockIdTable.assign(before);
    const content = (blocks: Block[]) =>
      new Map(ids.label(blocks).map(({ id, block }) => [id, block.kind === 'paragraph' ? block.text : block.kind]));
    const expected = content(before);
    const reply = paragraphIndex(doc, '회신 기한');
    const related = paragraphIndex(doc, '관련:');

    moveParagraphs(doc, S, reply, reply + 1, related);
    ids.paragraphsMoved(S, reply, reply + 1, related);

    expect(content(extractBlocks(doc))).toEqual(expected);
  });

  it('옮기다 실패하면 스냅샷으로 편집 전 문서로 되돌린다', () => {
    const doc = openFixture('notice.hwpx');
    const before = paragraphTexts(doc);
    const history = new EditHistory<string>(doc);
    const reply = paragraphIndex(doc, '회신 기한');

    expect(() =>
      history.apply('옮기기', 'before', () => {
        moveParagraphs(doc, S, reply, reply + 1, 5);
        throw new Error('검증 실패');
      }),
    ).toThrow('검증 실패');

    expect(paragraphTexts(doc)).toEqual(before);
    expect(history.size).toBe(0);
  });
});

describe('SPEC-002 글자 바꾸기 (기술 검증)', () => {
  it('바뀐 글자는 바뀌는 자리 첫 글자의 글자 모양을 따른다', () => {
    const boldFirst = mixedDocument();
    const boldId = charShapeIdAt(boldFirst, 0, 2);
    replaceParagraphText(boldFirst, S, 0, 'XY', 2, 4);
    expect(textOf(boldFirst, 0)).toBe('가나XY마바');
    expect([charShapeIdAt(boldFirst, 0, 2), charShapeIdAt(boldFirst, 0, 3)]).toEqual([boldId, boldId]);

    const plainFirst = mixedDocument();
    const plainId = charShapeIdAt(plainFirst, 0, 1);
    replaceParagraphText(plainFirst, S, 0, 'XYZ', 1, 3);
    expect(textOf(plainFirst, 0)).toBe('가XYZ라마바');
    expect(charShapeIdAt(plainFirst, 0, 1)).toBe(plainId);
    expect(charShapeIdAt(plainFirst, 0, 4)).toBe(boldId);
  });

  it('rhwp replaceText 는 앞 글자 모양을 따라서 쓰지 않는다 (근거)', () => {
    const doc = mixedDocument();
    const plainId = charShapeIdAt(doc, 0, 0);
    doc.replaceText(S, 0, 2, 2, 'XY');
    expect(charShapeIdAt(doc, 0, 2)).toBe(plainId);
  });

  it('범위를 주지 않으면 문단 전체를, 빈 글자를 주면 범위를 지운다', () => {
    const whole = mixedDocument();
    replaceParagraphText(whole, S, 0, '새 문장');
    expect(textOf(whole, 0)).toBe('새 문장');

    const erase = mixedDocument();
    replaceParagraphText(erase, S, 0, '', 2, 4);
    expect(textOf(erase, 0)).toBe('가나마바');
  });

  it('글자 위치는 유니코드 글자 단위다', () => {
    const doc = createBlankDocument();
    doc.insertText(S, 0, 0, '😀가𠀀나');
    replaceParagraphText(doc, S, 0, 'X', 2, 3);
    expect(textOf(doc, 0)).toBe('😀가X나');
  });

  it('줄바꿈이 든 글자로는 바꾸지 않는다', () => {
    const doc = mixedDocument();
    expect(() => replaceParagraphText(doc, S, 0, '가\n나')).toThrow('줄바꿈');
    expect(textOf(doc, 0)).toBe('가나다라마바');
  });

  it('표 칸 글자를 바꾸고 칸 첫 글자 모양을 따른다', () => {
    const doc = openFixture('notice.hwpx');
    const table = extractBlocks(doc).find((b) => b.kind === 'table');
    if (table === undefined) throw new Error('표가 없다');
    const cell = { section: S, paragraph: table.paragraph, controlIndex: table.controlIndex, cellIndex: 4 };
    doc.applyCharFormatInCell(S, table.paragraph, table.controlIndex, 4, 0, 4, 7, JSON.stringify({ bold: true }));
    const boldId: unknown = JSON.parse(doc.getCellCharPropertiesAt(S, table.paragraph, table.controlIndex, 4, 0, 4)).charShapeId;

    // "11. 20.(목) 14:00" 의 "20." → "21."
    replaceCellText(doc, cell, '21.', 4, 7);

    const after = extractBlocks(doc).find((b) => b.kind === 'table');
    expect(after?.kind === 'table' ? after.cells[4]?.text : undefined).toBe('11. 21.(목) 14:00');
    expect(JSON.parse(doc.getCellCharPropertiesAt(S, table.paragraph, table.controlIndex, 4, 0, 4)).charShapeId).toBe(boldId);
  });

  it('칸 안 여러 문단에 걸친 범위를 바꾸면 그 문단들이 합쳐진다', () => {
    const doc = createBlankDocument();
    const table = createdTable(doc.createTable(S, 0, 0, 1, 1));
    doc.insertTextInCell(S, table.paragraph, table.control, 0, 0, 0, '첫 줄');
    doc.splitParagraphInCell(S, table.paragraph, table.control, 0, 0, 3);
    doc.insertTextInCell(S, table.paragraph, table.control, 0, 1, 0, '둘째 줄');
    const cell = { section: S, paragraph: table.paragraph, controlIndex: table.control, cellIndex: 0 };

    // "첫 줄\n둘째 줄" 의 "줄\n둘째" → "칸"
    replaceCellText(doc, cell, '칸', 2, 6);

    const lines = [0, 1].slice(0, doc.getCellParagraphCount(S, table.paragraph, table.control, 0)).map((p) =>
      doc.getTextInCell(S, table.paragraph, table.control, 0, p, 0, doc.getCellParagraphLength(S, table.paragraph, table.control, 0, p)),
    );
    expect(lines).toEqual(['첫 칸 줄']);
  });

  it('누름틀 값을 바꾸면 값 첫 글자 모양을 따르고, 빈 누름틀은 값을 넣는다', () => {
    const doc = openFixture('application.hwpx');
    const applicant = listFields(doc).find((f) => f.name === '신청인');
    if (applicant === undefined) throw new Error('신청인 누름틀이 없다');

    replaceFieldText(doc, applicant.fieldId, '홍길동');
    const field = listFields(doc).find((f) => f.fieldId === applicant.fieldId);
    expect(field?.value).toBe('홍길동');

    const p = applicant.location.paraIndex;
    doc.applyCharFormat(S, p, applicant.startCharIdx, applicant.startCharIdx + 3, JSON.stringify({ bold: true }));
    const boldId = charShapeIdAt(doc, p, applicant.startCharIdx);
    replaceFieldText(doc, applicant.fieldId, '김철수입니다');

    expect(listFields(doc).find((f) => f.fieldId === applicant.fieldId)?.value).toBe('김철수입니다');
    expect(charShapeIdAt(doc, p, applicant.startCharIdx + 5)).toBe(boldId);
  });

  it('rhwp setFieldValue 는 값의 글자 모양을 버려서 값이 있을 때 쓰지 않는다 (근거)', () => {
    const doc = openFixture('application.hwpx');
    const applicant = listFields(doc).find((f) => f.name === '신청인');
    if (applicant === undefined) throw new Error('신청인 누름틀이 없다');
    const p = applicant.location.paraIndex;
    doc.setFieldValue(applicant.fieldId, '홍길동');
    doc.applyCharFormat(S, p, applicant.startCharIdx, applicant.startCharIdx + 3, JSON.stringify({ bold: true }));
    const boldId = charShapeIdAt(doc, p, applicant.startCharIdx);

    doc.setFieldValue(applicant.fieldId, '김철수');

    expect(charShapeIdAt(doc, p, applicant.startCharIdx)).not.toBe(boldId);
  });

  it('표 칸 안 누름틀 값도 값 첫 글자 모양을 따른다', () => {
    const doc = createBlankDocument();
    const { paragraph: tableParagraph, control } = createdTable(doc.createTable(S, 0, 0, 1, 2));
    doc.insertTextInCell(S, tableParagraph, control, 0, 0, 0, '성명');
    doc.insertClickHereFieldInCell(S, tableParagraph, control, 1, 0, 0, false, '이름', '', '성명값', true);
    const field = listFields(doc).find((f) => f.name === '성명값');
    if (field === undefined) throw new Error('칸 누름틀이 없다');
    replaceFieldText(doc, field.fieldId, '홍길동');
    doc.applyCharFormatInCell(S, tableParagraph, control, 1, 0, 0, 3, JSON.stringify({ bold: true }));
    const boldId: unknown = JSON.parse(doc.getCellCharPropertiesAt(S, tableParagraph, control, 1, 0, 0)).charShapeId;

    replaceFieldText(doc, field.fieldId, '김영희');

    expect(listFields(doc).find((f) => f.fieldId === field.fieldId)?.value).toBe('김영희');
    expect(JSON.parse(doc.getCellCharPropertiesAt(S, tableParagraph, control, 1, 0, 1)).charShapeId).toBe(boldId);
  });
});

describe('SPEC-002 문단 넣기 (기술 검증)', () => {
  it('기준 문단 앞에 넣으면 기준 문단의 문단 모양·첫 글자 모양을 따르고 번호가 다시 매겨진다', () => {
    const doc = openFixture('notice.hwpx');
    const related = paragraphIndex(doc, '관련:');
    const shape = paraShapeId(doc, related);
    const look = charLook(doc, S, related, 0);

    const at = insertParagraphNear(doc, S, related, 'before', '새로 넣은 항목');

    expect(at).toBe(related);
    expect(textOf(doc, at)).toBe('새로 넣은 항목');
    expect(paraShapeId(doc, at)).toBe(shape);
    expect(charLook(doc, S, at, 0)).toBe(look);
    expect(numbered(extractBlocks(doc)).filter((n) => /^\d/.test(n)).slice(0, 2)).toEqual(['1. 새로 넣은 ', '2. 관련: 가나']);
  });

  it('rhwp 는 구역 첫 문단 앞에 넣으면 구역 정의를 둘째 문단에 남기고, HWPX 로 저장해 다시 열면 구역 정의가 둘이 된다 (근거)', () => {
    const doc = openFixture('notice.hwpx');
    doc.insertParagraph(S, 0);
    doc.insertText(S, 0, 0, '맨 앞');
    const sectionDefs = (d: HwpDocument) =>
      z.array(z.object({ ctrlId: z.string(), para: z.number() })).parse(JSON.parse(d.getControls())).filter((c) => c.ctrlId === 'secd').map((c) => c.para);
    expect(sectionDefs(doc)).toEqual([1]);
    expect(sectionDefs(new HwpDocument(doc.exportHwpx()))).toEqual([0, 1]);
  });

  it('rhwp insertParagraph 는 앞 문단 모양을 물려줘서 앞에 넣을 때 바로잡는다 (근거)', () => {
    const doc = openFixture('notice.hwpx');
    const firstSub = paragraphIndex(doc, '교육 대상');
    const above = paraShapeId(doc, firstSub - 1);
    doc.insertParagraph(S, firstSub);
    expect(paraShapeId(doc, firstSub)).toBe(above);
    expect(paraShapeId(doc, firstSub)).not.toBe(paraShapeId(doc, firstSub + 1));
  });

  it('기준 문단 뒤에 넣으면 기준 문단 모양과 끝 글자 모양을 따른다', () => {
    const doc = openFixture('notice.hwpx');
    const look = charLook(doc, S, 0, 0);
    const shape = paraShapeId(doc, 0);

    const at = insertParagraphNear(doc, S, 0, 'after', '나라동 주민센터');

    expect(at).toBe(1);
    expect(paraShapeId(doc, 1)).toBe(shape);
    expect(charLook(doc, S, 1, 0)).toBe(look);
  });

  it('넣은 문단은 id 표에서 새 id 를 받고 기존 id 는 같은 내용을 가리킨다', () => {
    const doc = openFixture('notice.hwpx');
    const before = extractBlocks(doc);
    const ids = BlockIdTable.assign(before);
    const text = (blocks: Block[]) =>
      new Map(ids.label(blocks).map(({ id, block }) => [id, block.kind === 'paragraph' ? block.text : block.kind]));
    const expected = text(before);
    const related = paragraphIndex(doc, '관련:');

    const at = insertParagraphNear(doc, S, related, 'before', '새 항목');
    const newId = ids.paragraphInserted(S, at);

    const after = text(extractBlocks(doc));
    expect(after.get(newId)).toBe('새 항목');
    for (const [id, value] of expected) expect(after.get(id)).toBe(value);
  });
});

describe('SPEC-002 되돌리기 (기술 검증)', () => {
  it(`편집을 ${UNDO_LIMIT}단계까지 되돌리고, 그보다 옛 편집은 되돌릴 수 없다`, () => {
    const doc = createBlankDocument();
    doc.insertText(S, 0, 0, '0');
    const history = new EditHistory<number>(doc);
    for (let step = 1; step <= UNDO_LIMIT + 1; step += 1) {
      history.apply(`바꾸기 ${step}`, step - 1, () => replaceParagraphText(doc, S, 0, String(step)));
    }
    expect(history.size).toBe(UNDO_LIMIT);

    const undone = history.undo(UNDO_LIMIT);

    expect(undone?.labels).toHaveLength(UNDO_LIMIT);
    expect(undone?.labels[0]).toBe(`바꾸기 ${UNDO_LIMIT + 1}`);
    expect(undone?.state).toBe(1);
    expect(textOf(doc, 0)).toBe('1');
    expect(history.undo()).toBeUndefined();
  });

  it('되돌리면 블록 id 표도 그 편집 전 상태로 돌아간다', () => {
    const doc = openFixture('notice.hwpx');
    const blocks = extractBlocks(doc);
    let ids = BlockIdTable.assign(blocks);
    const history = new EditHistory<BlockIdTable>(doc);
    const related = paragraphIndex(doc, '관련:');

    const at = history.apply('넣기', ids.clone(), () => insertParagraphNear(doc, S, related, 'before', '새 항목'));
    const newId = ids.paragraphInserted(S, at);
    expect(ids.anchor(newId)).toBeDefined();

    const undone = history.undo();
    if (undone === undefined) throw new Error('되돌릴 것이 없다');
    ids = undone.state;

    expect(ids.anchor(newId)).toBeUndefined();
    expect(ids.label(extractBlocks(doc)).map(({ id }) => id)).toEqual(BlockIdTable.assign(blocks).label(blocks).map(({ id }) => id));
  });

  it('거부된 편집은 기록하지 않는다', () => {
    const doc = createBlankDocument();
    doc.insertText(S, 0, 0, '첫째');
    doc.splitParagraph(S, 0, 2);
    doc.insertText(S, 1, 0, '둘째');
    doc.splitParagraph(S, 1, 2);
    doc.insertText(S, 2, 0, '각주 문단');
    doc.insertFootnote(S, 2, 1);
    const history = new EditHistory<null>(doc);

    const result = history.apply('옮기기', null, () => moveParagraphs(doc, S, 2, 3, 1), (r) => r.ok);

    expect(result.ok).toBe(false);
    expect(history.size).toBe(0);
  });

});

describe('SPEC-002 HWPX 저장 검증 (기술 검증)', () => {
  it('옮기고 바꾸고 칸·누름틀을 채운 fixture 3개를 HWPX 로 내보내 다시 열면 블록이 같다', () => {
    const notice = openFixture('notice.hwpx');
    moveParagraphs(notice, S, paragraphIndex(notice, '회신 기한'), paragraphIndex(notice, '회신 기한') + 1, paragraphIndex(notice, '관련:'));
    replaceParagraphText(notice, S, paragraphIndex(notice, '회신 기한'), '7.', 17, 20);
    const report = openFixture('report.hwpx');
    moveParagraphs(report, S, paragraphIndex(report, '개선 과제'), paragraphIndex(report, '향후 계획'), paragraphIndex(report, '이용 현황'));
    const application = openFixture('application.hwpx');
    for (const field of listFields(application)) replaceFieldText(application, field.fieldId, field.name === '신청인' ? '홍길동' : '2026. 11. 3.');

    for (const doc of [notice, report, application]) {
      const result = exportVerifiedHwpx(doc);
      expect(result.different).toEqual([]);
      expect(result.losses).toEqual([]);
      expect(result.bytes.length).toBeGreaterThan(0);
    }
  });

  it('다시 연 문서와 블록이 다르면 달라진 블록 자리를 돌려준다', () => {
    const original = extractBlocks(openFixture('notice.hwpx'));
    const edited = openFixture('notice.hwpx');
    replaceParagraphText(edited, S, paragraphIndex(edited, '가나다구청장'), '나라시장');
    const changed = original.findIndex((b) => b.kind === 'paragraph' && b.text === '가나다구청장');

    expect(differentBlocks(original, extractBlocks(edited))).toEqual([changed]);
    expect(differentBlocks(original, original.slice(0, -1))).toEqual([original.length - 1]);
  });
});
