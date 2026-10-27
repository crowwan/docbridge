// 문서 사이 복사 기술 검증(#62)의 원본 문서: 공문 fixture(notice.hwpx) 끝에 그림 문단·사용자 스타일 문단·개요 스타일 문단을 더한 것.
// tests/copy-spike.test.ts 와 scripts/make-copy-check.ts 가 같이 쓴다.
import type { HwpDocument } from '@rhwp/core';
import { styleById, findStyle, resetToStyle } from '../src/core/styles.ts';
import { openFixture } from './fixtures.ts';

const S = 0;
export const ONE_PIXEL_PNG = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);

/** 원본에만 있는 사용자 스타일(대상 fixture 에는 이 이름이 없다) */
export const SOURCE_ONLY_STYLE = { name: '강조 문단', fontSize: 1400, textColor: '#0000ff', alignment: 'right' } as const;

/** 원본 문서의 문단 번호(구역 0). notice.hwpx 0~14 + 더한 15~17 */
export const SRC = {
  /** "수신" 누름틀이 든 문단 */
  field: 1,
  /** 자동 번호 1. 관련 ~ 3. 회신 기한 (가.·나.·다. 포함) */
  numbered: { start: 5, end: 11 },
  /** 3×3 표가 든 문단 */
  table: 11,
  /** 가운데 정렬 18pt 굵게(직접 서식) "가나다구청장" */
  signature: 14,
  /** 그림(1×1 PNG)이 든 문단 */
  picture: 15,
  /** 원본에만 있는 스타일 "강조 문단" 문단 */
  sourceStyle: 16,
  /** "개요 1" 스타일 문단 */
  outlineStyle: 17,
} as const;

function appendParagraph(doc: HwpDocument, text: string): number {
  const last = doc.getParagraphCount(S) - 1;
  doc.splitParagraph(S, last, doc.getParagraphLength(S, last));
  doc.insertText(S, last + 1, 0, text);
  return last + 1;
}

export function buildCopySource(): HwpDocument {
  const doc = openFixture('notice.hwpx');
  const picture = appendParagraph(doc, '그림 문단 ');
  doc.insertPicture(S, picture, 5, '', ONE_PIXEL_PNG, 3000, 3000, 1, 1, 'png', '그림');

  const custom = doc.createStyle(JSON.stringify({ name: SOURCE_ONLY_STYLE.name, englishName: 'Emphasis', type: 0, nextStyleId: 0 }));
  doc.updateStyleShapes(
    custom,
    JSON.stringify({ bold: true, fontSize: SOURCE_ONLY_STYLE.fontSize, textColor: SOURCE_ONLY_STYLE.textColor }),
    JSON.stringify({ alignment: SOURCE_ONLY_STYLE.alignment }),
  );
  resetToStyle(doc, S, appendParagraph(doc, '강조 스타일 문단'), styleById(doc, custom));
  resetToStyle(doc, S, appendParagraph(doc, '개요 스타일 문단'), findStyle(doc, '개요 1'));
  return doc;
}
