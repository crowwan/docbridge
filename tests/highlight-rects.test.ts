import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { alignLeftToCaret, selectionRects } from '../src/core/highlight-rects.ts';
import { openFixture } from './fixtures.ts';

const caretX = (json: string) => z.object({ x: z.number() }).parse(JSON.parse(json)).x;

describe('SPEC-001 하이라이트 사각형 (기술 검증)', () => {
  it('가운데 정렬 줄을 처음부터 고르면 사각형이 글자 시작 위치에서 시작한다', () => {
    const doc = openFixture('notice.hwpx');
    const [rect] = selectionRects(doc, { section: 0, startParagraph: 0, startOffset: 0, endParagraph: 0, endOffset: 5 });
    expect(rect?.x).toBeCloseTo(caretX(doc.getCursorRect(0, 0, 0)), 1);
  });

  it('번호 문단의 사각형은 번호 문자를 덮지 않고, 다음 줄도 그 줄 첫 글자에서 시작한다', () => {
    const doc = openFixture('notice.hwpx');
    const length = doc.getParagraphLength(0, 6);
    const rects = selectionRects(doc, { section: 0, startParagraph: 6, startOffset: 0, endParagraph: 6, endOffset: length });

    expect(rects).toHaveLength(2);
    expect(rects[0]?.x).toBeCloseTo(caretX(doc.getCursorRect(0, 6, 0)), 1);
    expect(rects[1]?.x).toBeCloseTo(caretX(doc.getCursorRectOnLine(0, 6, 1, false, 0xffffffff, 0, 0, 0)), 1);
    // 내어쓰기한 둘째 줄도 번호 자리(단 왼쪽 끝)가 아니라 글자 자리에서 시작한다
    const columnLeft = z.object({ bodyLeft: z.number() }).parse(JSON.parse(doc.getPageInfo(0))).bodyLeft;
    expect(rects[1]?.x).toBeGreaterThan(columnLeft);
  });

  it('줄 중간에서 시작하는 범위는 rhwp 사각형을 그대로 쓴다', () => {
    const doc = openFixture('notice.hwpx');
    const range = { section: 0, startParagraph: 10, startOffset: 7, endParagraph: 10, endOffset: 20 };
    const raw = z.array(z.object({ x: z.number(), width: z.number() })).parse(JSON.parse(doc.getSelectionRects(0, 10, 7, 10, 20)));
    expect(selectionRects(doc, range).map(({ x, width }) => ({ x, width }))).toEqual(raw);
  });

  it('표 칸 안 범위도 사각형을 준다', () => {
    const doc = openFixture('notice.hwpx');
    const rects = selectionRects(doc, {
      section: 0,
      cell: { parentParagraph: 11, controlIndex: 0, cellIndex: 8 },
      startParagraph: 0,
      startOffset: 0,
      endParagraph: 0,
      endOffset: 8,
    });
    expect(rects).toHaveLength(1);
    expect(rects[0]?.width).toBeGreaterThan(0);
  });

  it('캐럿이 사각형 오른쪽 끝이거나 그보다 오른쪽이면 사각형을 바꾸지 않는다(폭이 0 이하가 되지 않는다)', () => {
    const rect = { pageIndex: 0, x: 100, y: 10, width: 50, height: 13 };
    expect(alignLeftToCaret(rect, { pageIndex: 0, x: 150 })).toEqual(rect);
    expect(alignLeftToCaret(rect, { pageIndex: 0, x: 170 })).toEqual(rect);
    expect(alignLeftToCaret(rect, { pageIndex: 0, x: 120 })).toEqual({ ...rect, x: 120, width: 30 });
  });
});
