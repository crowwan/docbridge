import { expect, test, type Page } from '@playwright/test';
import type { SelectionRect, TextRange } from '../src/viewer/api.ts';
import { inkBounds, openFixture } from './viewer.ts';

// 오버레이 위치 허용 오차(px). 화면 좌표는 소수점 반올림이 있어 0.5px 까지 본다.
const POSITION_TOLERANCE = 0.5;
// 글자 잉크와 사각형 경계 허용 오차(px). 안티앨리어싱 화소가 1px 남짓 번진다.
const INK_TOLERANCE = 2;
// 사각형 끝과 글자 잉크 사이 허용 빈틈(px). 글자 옆 여백(마침표 등)이 3~4px 있다.
const EDGE_GAP = 4;
// 잉크를 찾는 띠의 위아래 여유(px). 오차보다 1px 넓고, 표처럼 줄이 붙은 곳에서 옆 줄 글자를 넘지 않는다.
const BAND_MARGIN = INK_TOLERANCE + 1;

async function highlight(page: Page, range: TextRange): Promise<SelectionRect[]> {
  return page.evaluate((r) => window.docbridge?.highlight(r) ?? [], range);
}

// 오버레이 요소가 getSelectionRects 사각형과 같은 자리에 그려졌는지 본다
async function expectOverlayMatchesRects(page: Page, rects: SelectionRect[]): Promise<void> {
  for (const [i, rect] of rects.entries()) {
    const pageBox = await page.getByTestId(`page-canvas-${rect.pageIndex}`).boundingBox();
    const box = await page.getByTestId(`highlight-${i}`).boundingBox();
    if (!pageBox || !box) throw new Error('오버레이나 쪽이 화면에 없다');
    expect(Math.abs(box.x - (pageBox.x + rect.x))).toBeLessThanOrEqual(POSITION_TOLERANCE);
    expect(Math.abs(box.y - (pageBox.y + rect.y))).toBeLessThanOrEqual(POSITION_TOLERANCE);
    expect(Math.abs(box.width - rect.width)).toBeLessThanOrEqual(POSITION_TOLERANCE);
    expect(Math.abs(box.height - rect.height)).toBeLessThanOrEqual(POSITION_TOLERANCE);
  }
}

// 사각형 가로 범위 안, 사각형보다 위아래로 조금 넓은 띠에서 글자 잉크가 사각형 안에 들어가고
// (사각형이 어긋나면 글자가 띠 끝에 걸려 실패한다),
// 사각형 양 끝이 첫 글자·끝 글자 잉크에 붙어 있는지(글자 앞 빈 곳이나 번호를 덮지 않는지) 본다
async function expectRectsCoverInk(page: Page, rects: SelectionRect[]): Promise<void> {
  for (const rect of rects) {
    const ink = await inkBounds(page, rect.pageIndex, {
      left: rect.x,
      right: rect.x + rect.width,
      top: rect.y - BAND_MARGIN,
      bottom: rect.y + rect.height + BAND_MARGIN,
    });
    if (!ink) throw new Error('사각형 자리에 글자가 없다');
    expect(ink.top).toBeGreaterThanOrEqual(rect.y - INK_TOLERANCE);
    expect(ink.bottom).toBeLessThanOrEqual(rect.y + rect.height + INK_TOLERANCE);
    expect(ink.left - rect.x).toBeLessThanOrEqual(EDGE_GAP);
    expect(rect.x + rect.width - ink.right).toBeLessThanOrEqual(EDGE_GAP);
  }
}

test.describe('SPEC-001 하이라이트 좌표 (기술 검증)', () => {
  test('한 줄 문단 전체를 하이라이트하면 오버레이가 글자 위에 겹친다', async ({ page }) => {
    await openFixture(page, 'notice.hwpx');
    // "가나다구청" 제목(20pt, 가운데 정렬)
    const rects = await highlight(page, { section: 0, startParagraph: 0, startOffset: 0, endParagraph: 0, endOffset: 5 });

    expect(rects).toHaveLength(1);
    await expectOverlayMatchesRects(page, rects);
    await expectRectsCoverInk(page, rects);
  });

  test('여러 줄 문단은 줄마다 사각형을 그리고 각 줄 글자 위에 겹친다', async ({ page }) => {
    await openFixture(page, 'notice.hwpx');
    // "2. 하반기 주민 안전교육을 …" 두 줄 문단(번호 문자는 범위 밖)
    const rects = await highlight(page, { section: 0, startParagraph: 6, startOffset: 0, endParagraph: 6, endOffset: 67 });

    expect(rects.length).toBeGreaterThanOrEqual(2);
    await expectOverlayMatchesRects(page, rects);
    await expectRectsCoverInk(page, rects);
    await page.getByRole('region', { name: '1쪽' }).screenshot({ path: 'test-results/screens/highlight-notice-multiline.png' });
  });

  test('문단 일부(날짜)만 하이라이트하면 그 글자만 덮는다', async ({ page }) => {
    await openFixture(page, 'notice.hwpx');
    // "회신 기한: 2026. 11. 14.(금)까지 …" 에서 "2026. 11. 14." (7~20)
    const rects = await highlight(page, { section: 0, startParagraph: 10, startOffset: 7, endParagraph: 10, endOffset: 20 });

    expect(rects).toHaveLength(1);
    await expectOverlayMatchesRects(page, rects);
    await expectRectsCoverInk(page, rects);
    await page.getByRole('region', { name: '1쪽' }).screenshot({ path: 'test-results/screens/highlight-notice-partial.png' });
  });

  test('표 칸 안 글자도 하이라이트가 겹친다', async ({ page }) => {
    await openFixture(page, 'notice.hwpx');
    // 표(문단 11) 마지막 칸 "구민회관 소강당"
    const rects = await highlight(page, {
      section: 0,
      cell: { parentParagraph: 11, controlIndex: 0, cellIndex: 8 },
      startParagraph: 0,
      startOffset: 0,
      endParagraph: 0,
      endOffset: 8,
    });

    expect(rects).toHaveLength(1);
    await expectOverlayMatchesRects(page, rects);
    await expectRectsCoverInk(page, rects);
  });

  test('새 하이라이트를 그리면 이전 하이라이트는 지워지고, 뒤쪽 대상으로 스크롤한다', async ({ page }) => {
    const metrics = await openFixture(page, 'report.hwpx');
    await highlight(page, { section: 0, startParagraph: 0, startOffset: 0, endParagraph: 0, endOffset: 5 });
    // 마지막 문단("참고 12. …")은 마지막 쪽에 있다
    const rects = await highlight(page, { section: 0, startParagraph: 39, startOffset: 0, endParagraph: 39, endOffset: 8 });

    expect(rects[0]?.pageIndex).toBe(metrics.pageCount - 1);
    await expect(page.locator('.highlight')).toHaveCount(rects.length);
    await expect(page.getByTestId('highlight-0')).toBeInViewport();
    await expectOverlayMatchesRects(page, rects);
    await expectRectsCoverInk(page, rects);
    await page.getByRole('region', { name: `${metrics.pageCount}쪽` }).screenshot({ path: 'test-results/screens/highlight-report-last-page.png' });
  });
});
