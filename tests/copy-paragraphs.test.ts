// SPEC-007 copy_blocks 의 대상 쪽 보정(src/core/copy-paragraphs.ts) — PR #70 리뷰 후속(#64).
// 기술 검증(tests/copy-spike.test.ts)이 고정한 동작 위에, 다음 스타일 참조·넣는 자리 앞 번호 목록·큰 대상 문서·updateStyle 실패를 본다.
import type { HwpDocument } from '@rhwp/core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { extractBlocks } from '../src/core/blocks.ts';
import { copyParagraphs, type CopyResult } from '../src/core/copy-paragraphs.ts';
import { parseJson } from '../src/core/json.ts';
import { findStyle, resetToStyle, styleById } from '../src/core/styles.ts';
import { buildCopySource, SOURCE_ONLY_STYLE, SRC } from './copy-source.ts';
import { openFixture } from './fixtures.ts';

const S = 0;
const styleListSchema = z.array(z.object({ id: z.number(), name: z.string(), nextStyleId: z.number() }));
const styles = (doc: HwpDocument) => parseJson(styleListSchema, doc.getStyleList());
const styleNamed = (doc: HwpDocument, name: string) => {
  const found = styles(doc).find((style) => style.name === name);
  if (found === undefined) throw new Error(`${name} 스타일이 없다`);
  return found;
};

function copied(result: CopyResult) {
  if (!result.ok) throw new Error(`복사가 거부됐다: ${JSON.stringify(result.rejected)}`);
  return result;
}

/** 문서 끝에 문단을 하나 더하고 그 번호를 돌려준다 */
function appendParagraph(doc: HwpDocument, text: string): number {
  const last = doc.getParagraphCount(S) - 1;
  doc.splitParagraph(S, last, doc.getParagraphLength(S, last));
  doc.insertText(S, last + 1, 0, text);
  return last + 1;
}

/** 번호 문단의 "번호 앞 글자" */
const numberedLines = (doc: HwpDocument) =>
  extractBlocks(doc).flatMap((block) => (block.kind === 'paragraph' && block.number !== undefined ? [`${block.number} ${block.text.slice(0, 6)}`] : []));

describe('SPEC-007 copy_blocks — 대상 문서 보정 (copyParagraphs, PR #70 리뷰 후속)', () => {
  it('AC-6 복제 스타일을 지운 뒤에도 더한 스타일의 다음 스타일이 대상의 같은 이름 스타일을 가리킨다', () => {
    const source = buildCopySource();
    // 원본: "강조 문단" 다음 = 자기 자신, "다음은 개요" 다음 = "개요 1"(대상에도 있는 이름 — 복제는 지워진다)
    const emphasis = findStyle(source, SOURCE_ONLY_STYLE.name).id;
    expect(source.updateStyle(emphasis, JSON.stringify({ nextStyleId: emphasis }))).toBe(true);
    const nextOutline = source.createStyle(
      JSON.stringify({ name: '다음은 개요', englishName: 'Next Outline', type: 0, nextStyleId: findStyle(source, '개요 1').id }),
    );
    resetToStyle(source, S, appendParagraph(source, '다음은 개요 문단'), styleById(source, nextOutline));
    const target = openFixture('report.hwpx');

    const { corrections } = copied(
      copyParagraphs(target, source.exportHwpx(), { section: S, start: SRC.sourceStyle, end: SRC.outlineStyle + 2 }, { section: S, before: 2 }),
    );

    expect(corrections.deletedStyles).toContain('개요 1');
    const added = styleNamed(target, SOURCE_ONLY_STYLE.name);
    expect(added.nextStyleId).toBe(added.id);
    expect(styleNamed(target, '다음은 개요').nextStyleId).toBe(styleNamed(target, '개요 1').id);
  });

  it('같은 모양의 번호 목록이 대상에 둘이면 넣는 자리 바로 앞 문단의 번호 목록을 잇는다', () => {
    const target = openFixture('notice.hwpx');
    // 공문 번호 목록(1. 관련 / 2. 하반기 / 3. 회신)과 같은 모양의 두 번째 목록을 문서 끝에 만든다
    const second = target.createNumbering(
      JSON.stringify({ levelFormats: ['^1.', '^2.', '^3)', '', '', '', ''], numberFormats: [0, 8, 0, 0, 0, 0, 0], startNumber: 1 }),
    );
    for (const text of ['다른 목록 하나', '다른 목록 둘']) {
      target.applyParaFormat(S, appendParagraph(target, text), JSON.stringify({ headType: 'Number', numberingId: second }));
    }

    // "3. 회신 기한" 을 두 번째 목록 뒤(문서 끝)에
    const end = target.getParagraphCount(S);
    copied(copyParagraphs(target, buildCopySource().exportHwpx(), { section: S, start: 10, end: 11 }, { section: S, before: end }));

    expect(numberedLines(target).slice(-3)).toEqual(['1. 다른 목록 ', '2. 다른 목록 ', '3. 회신 기한:']);
  });

  it('보정은 넣은 문단만 본다 — 대상 문서의 다른 문단 스타일을 훑지 않고, 스타일 목록도 문단마다 다시 읽지 않는다', () => {
    const target = openFixture('report.hwpx');
    // 대상을 크게: 문단 200개를 더한다
    for (let i = 0; i < 200; i += 1) appendParagraph(target, `큰 문서 문단 ${i}`);
    const styleAt = vi.spyOn(target, 'getStyleAt');
    const styleList = vi.spyOn(target, 'getStyleList');
    const range = { section: S, start: SRC.numbered.start, end: SRC.outlineStyle + 1 };

    copied(copyParagraphs(target, buildCopySource().exportHwpx(), range, { section: S, before: 2 }));

    const insertedCount = range.end - range.start;
    expect(styleAt.mock.calls.length).toBeLessThanOrEqual(insertedCount * 2);
    expect(styleList.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('복제 스타일 이름 바꾸기(updateStyle)가 실패하면 조용히 넘어가지 않고 던진다(같은 이름 스타일이 둘 남지 않게)', () => {
    const sourceDoc = buildCopySource();
    sourceDoc.applyCellStyle(S, SRC.table, 0, 0, 0, findStyle(sourceDoc, SOURCE_ONLY_STYLE.name).id); // 칸이 원본에만 있는 스타일 → 복제 바탕글은 이름 바꾸기
    const target = openFixture('report.hwpx');
    // 이름 바꾸기만 실패시킨다(다음 스타일 돌리기는 그대로)
    const updateStyle = target.updateStyle.bind(target);
    vi.spyOn(target, 'updateStyle').mockImplementation((id, json) => (json.includes('"name"') ? false : updateStyle(id, json)));

    expect(() =>
      copyParagraphs(target, sourceDoc.exportHwpx(), { section: S, start: SRC.table, end: SRC.table + 1 }, { section: S, before: 2 }),
    ).toThrow('복제 스타일 "바탕글" 의 이름을 바꾸지 못했습니다');
  });
});
