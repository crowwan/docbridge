// 서버(bridge + 문서 세션)가 내준 빌드된 뷰어에서 highlight · clear_highlight 가 실제 화면에 그려지는지 본다(AC-7).
// 대상은 블록 id·칸·글자 범위(TextTarget)로 주고, 오버레이가 캔버스의 글자 잉크를 덮는지로 확인한다. npm run e2e 가 먼저 빌드한다.
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { clearHighlight, highlight } from '../src/server/highlight-tools.ts';
import { findText, getOutline } from '../src/server/read-tools.ts';
import { DocumentSession } from '../src/server/session.ts';
import type { TextTarget } from '../src/shared/protocol.ts';
import { inkBounds } from './viewer.ts';

const viewerDir = fileURLToPath(new URL('../dist/viewer/', import.meta.url));
const fixturePath = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

// 글자 잉크와 오버레이 경계 허용 오차(px). 안티앨리어싱 화소가 1px 남짓 번진다(e2e/highlight.spec.ts 와 같은 기준)
const INK_TOLERANCE = 2;
// 오버레이 끝과 글자 잉크 사이 허용 빈틈(px)
const EDGE_GAP = 4;
const BAND_MARGIN = INK_TOLERANCE + 1;

let bridge: Bridge;
let session: DocumentSession;

test.beforeEach(async ({ page }) => {
  bridge = await startBridge({ port: 0, viewerDir });
  session = new DocumentSession(bridge, { openBrowser: (url) => void page.goto(url) });
});

test.afterEach(async () => {
  await bridge.close();
});

const overlays = (page: Page) => page.locator('.highlight');

/** 오버레이 하나가 놓인 쪽 번호(0부터)와 쪽 캔버스 기준 위치 */
async function overlayOnPage(page: Page, overlay: Locator) {
  const box = await overlay.boundingBox();
  if (!box) throw new Error('오버레이가 화면에 없다');
  for (let pageIndex = 0; ; pageIndex += 1) {
    const canvas = page.getByTestId(`page-canvas-${pageIndex}`);
    if ((await canvas.count()) === 0) throw new Error('오버레이가 어느 쪽에도 없다');
    const pageBox = await canvas.boundingBox();
    if (pageBox && box.y >= pageBox.y && box.y < pageBox.y + pageBox.height) {
      return { pageIndex, x: box.x - pageBox.x, y: box.y - pageBox.y, width: box.width, height: box.height };
    }
  }
}

// 오버레이마다 그 가로 범위·위아래로 조금 넓은 띠의 글자 잉크가 오버레이 안에 있고, 양 끝이 글자에 붙어 있는지 본다
async function expectOverlaysCoverInk(page: Page): Promise<void> {
  const count = await overlays(page).count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const rect = await overlayOnPage(page, page.getByTestId(`highlight-${i}`));
    const ink = await inkBounds(page, rect.pageIndex, {
      left: rect.x,
      right: rect.x + rect.width,
      top: rect.y - BAND_MARGIN,
      bottom: rect.y + rect.height + BAND_MARGIN,
    });
    if (!ink) throw new Error(`오버레이 ${i} 자리에 글자가 없다`);
    expect(ink.top).toBeGreaterThanOrEqual(rect.y - INK_TOLERANCE);
    expect(ink.bottom).toBeLessThanOrEqual(rect.y + rect.height + INK_TOLERANCE);
    expect(ink.left - rect.x).toBeLessThanOrEqual(EDGE_GAP);
    expect(rect.x + rect.width - ink.right).toBeLessThanOrEqual(EDGE_GAP);
  }
}

// 사용자 QA(#49) 상황처럼 세 줄쯤 되는 note
const LONG_NOTE =
  '교육 일정 안내 문단: 각 동 주민센터가 주민에게 알려 참석 인원을 모아 회신하라는 요청입니다. 회신 기한은 3번 항목에 있습니다.';

/** note 가 쪽 캔버스와 겹치는 자리에 문서 글자 잉크가 없는지 본다(쪽 밖 여백에 있으면 겹칠 글자가 없다) */
async function expectNoteClearOfText(page: Page): Promise<void> {
  const noteBox = await page.getByRole('note').boundingBox();
  const pageBox = await page.getByTestId('page-canvas-0').boundingBox();
  if (!noteBox || !pageBox) throw new Error('note 나 쪽이 화면에 없다');
  const region = {
    left: Math.max(0, noteBox.x - pageBox.x),
    top: Math.max(0, noteBox.y - pageBox.y),
    right: Math.min(pageBox.width, noteBox.x + noteBox.width - pageBox.x),
    bottom: Math.min(pageBox.height, noteBox.y + noteBox.height - pageBox.y),
  };
  if (region.right <= region.left || region.bottom <= region.top) return;
  expect(await inkBounds(page, 0, region)).toBeNull();
}

async function firstMatch(query: string): Promise<TextTarget> {
  const [match] = (await findText(session, query)).matches;
  if (match === undefined) throw new Error(`${query} 를 찾지 못했다`);
  const { before: _before, after: _after, ...target } = match;
  return target;
}

test.describe('SPEC-001 근거 하이라이트 (서버가 내주는 뷰어)', () => {
  test('find_text 로 찾은 문단 일부(날짜)를 highlight 하면 그 글자만 덮는다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));

    const result = await highlight(session, [await firstMatch('2026. 11. 14.')]);

    expect(result).toEqual({ highlighted: 1, pages: [1] });
    await expect(overlays(page)).toHaveCount(1);
    await expectOverlaysCoverInk(page);
    await page.getByRole('region', { name: '1쪽' }).screenshot({ path: 'test-results/screens/highlight-tool-partial.png' });
  });

  test('여러 줄 문단 블록 전체와 다음 문단을 함께 고르면 줄마다 글자 위에 겹친다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));

    // b7 = "하반기 주민 안전교육을 …"(두 줄, 번호 "2."), b8 = "교육 대상: …"(번호 "가.")
    await highlight(session, [{ id: 'b7' }, { id: 'b8' }]);

    await expect(overlays(page)).toHaveCount(3);
    await expectOverlaysCoverInk(page);
    await page.getByRole('region', { name: '1쪽' }).screenshot({ path: 'test-results/screens/highlight-tool-multiline.png' });
  });

  test('표 칸을 고르면 그 칸 글자를, 표만 고르면 표 전체를 덮는다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));

    await highlight(session, [{ id: 'b12', cell: { row: 2, col: 2 } }]);
    await expect(overlays(page)).toHaveCount(1);
    await expectOverlaysCoverInk(page);
    await page.getByRole('region', { name: '1쪽' }).screenshot({ path: 'test-results/screens/highlight-tool-cell.png' });

    await highlight(session, [{ id: 'b12' }]);
    await expect(overlays(page)).toHaveCount(1);
    const table = await overlayOnPage(page, page.getByTestId('highlight-0'));
    expect(table.width).toBeGreaterThan(500);
    expect(table.height).toBeGreaterThan(45);
  });

  test('값이 빈 누름틀을 고르면 그 자리에 그려진 안내문을 덮는다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));

    await highlight(session, [{ id: 'b3' }]);

    await expect(overlays(page)).toHaveCount(1);
    await expectOverlaysCoverInk(page);
  });

  test('note 를 주면 첫 대상 바로 옆(위)에 짧게 보인다 — 위 줄이 비어 있으면 바로 위', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));

    // b1 = 맨 위 기관명 "가나다구청". 위에 글자가 없다
    await highlight(session, [{ id: 'b1' }, { id: 'b12', cell: { row: 1, col: 1 } }], '보낸 기관');

    const note = page.getByRole('note');
    await expect(note).toHaveText('보낸 기관');
    await expect(note).toBeInViewport();
    const noteBox = await note.boundingBox();
    const firstBox = await page.getByTestId('highlight-0').boundingBox();
    if (!noteBox || !firstBox) throw new Error('note 나 하이라이트가 화면에 없다');
    expect(noteBox.y + noteBox.height).toBeLessThanOrEqual(firstBox.y);
    expect(firstBox.y - (noteBox.y + noteBox.height)).toBeLessThanOrEqual(8);
    expect(Math.abs(noteBox.x - firstBox.x)).toBeLessThanOrEqual(1);
    await expectNoteClearOfText(page);
    await page.getByRole('region', { name: '1쪽' }).screenshot({ path: 'test-results/screens/highlight-tool-note.png' });
  });

  test('앞 줄에 글자가 있고 쪽 오른쪽 바깥 여백이 넉넉하면 note 를 여백에 두어 문서 글자를 덮지 않는다(#51)', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1200 });
    await session.open(fixturePath('notice.hwpx'));

    // b7 = "2. 하반기 주민 안전교육을 …" 바로 위가 "1. 관련: …" 줄. 세 줄쯤 되는 긴 note(사용자 QA 상황)
    await highlight(session, [{ id: 'b7' }], LONG_NOTE);

    const note = page.getByRole('note');
    await expect(note).toBeInViewport();
    await page.screenshot({ path: 'test-results/screens/highlight-tool-note-margin.png' });
    await expectNoteClearOfText(page);
    const noteBox = await note.boundingBox();
    const pageBox = await page.getByTestId('page-canvas-0').boundingBox();
    const firstBox = await page.getByTestId('highlight-0').boundingBox();
    if (!noteBox || !pageBox || !firstBox) throw new Error('note 나 쪽이 화면에 없다');
    expect(noteBox.x).toBeGreaterThanOrEqual(pageBox.x + pageBox.width);
    expect(Math.abs(noteBox.y - firstBox.y)).toBeLessThanOrEqual(1);
    // 쪽 밖이라 폭이 쪼그라들지 않고(최소 폭 160px 이상) 화면 안에 들어온다
    expect(noteBox.width).toBeGreaterThanOrEqual(160);
    expect(noteBox.x + noteBox.width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  });

  test('앞 줄에 글자가 있고 바깥 여백도 좁으면 note 를 하이라이트 마지막 사각형 아래에 둔다(#51)', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 1200 });
    await session.open(fixturePath('notice.hwpx'));

    await highlight(session, [{ id: 'b7' }], LONG_NOTE);

    const note = page.getByRole('note');
    await expect(note).toBeInViewport();
    const noteBox = await note.boundingBox();
    const lastBox = await overlays(page).last().boundingBox();
    if (!noteBox || !lastBox) throw new Error('note 나 하이라이트가 화면에 없다');
    expect(noteBox.y).toBeGreaterThanOrEqual(lastBox.y + lastBox.height);
    expect(noteBox.y - (lastBox.y + lastBox.height)).toBeLessThanOrEqual(8);
    await page.getByRole('region', { name: '1쪽' }).screenshot({ path: 'test-results/screens/highlight-tool-note-below.png' });
  });

  test('highlight 를 부르면 첫 대상이 화면에 보이도록 스크롤되고, 이전 하이라이트는 지워진다', async ({ page }) => {
    const opened = await session.open(fixturePath('report.hwpx'));
    const outline = await getOutline(session);
    const first = outline.blocks[0];
    const last = outline.blocks.at(-1);
    if (first === undefined || last === undefined) throw new Error('블록이 없다');

    await highlight(session, [{ id: first.id }], '첫 블록');
    await expect(page.getByTestId('highlight-0')).toBeInViewport();

    const result = await highlight(session, [{ id: last.id }]);

    expect(result.pages).toEqual([opened.pageCount]);
    await expect(page.getByRole('note')).toHaveCount(0);
    const lastRegion = page.getByRole('region', { name: `${opened.pageCount}쪽` });
    await expect(lastRegion.locator('.highlight')).toHaveCount(await overlays(page).count());
    await expect(page.getByTestId('highlight-0')).toBeInViewport();
    // 1쪽은 거의 화면 밖으로 밀려난다
    await expect(page.getByTestId('page-canvas-0')).not.toBeInViewport({ ratio: 0.5 });
    await expectOverlaysCoverInk(page);
    await page.screenshot({ path: 'test-results/screens/highlight-tool-scrolled.png' });
  });

  test('뒤쪽 대상을 먼저 주면 문서 순서가 아니라 첫 대상(과 note)이 보이도록 스크롤한다(PR #14 리뷰)', async ({ page }) => {
    const opened = await session.open(fixturePath('report.hwpx'));
    const outline = await getOutline(session);
    const first = outline.blocks[0];
    const last = outline.blocks.at(-1);
    if (first === undefined || last === undefined) throw new Error('블록이 없다');

    const result = await highlight(session, [{ id: last.id }, { id: first.id }], '마지막 블록');

    expect(result.pages).toEqual([1, opened.pageCount]);
    const lastRegion = page.getByRole('region', { name: `${opened.pageCount}쪽` });
    await expect(lastRegion.locator('.highlight').first()).toBeInViewport();
    await expect(page.getByRole('note')).toBeInViewport();
  });

  test('대상 하나라도 틀리면 오류를 돌려주고 이전 하이라이트를 그대로 둔다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));
    await highlight(session, [{ id: 'b1' }], '제목');

    await expect(highlight(session, [{ id: 'b5' }, { id: 'b1', start: 0, end: 99 }])).rejects.toThrow('b1: 글자 범위가 맞지 않습니다');

    await expect(overlays(page)).toHaveCount(1);
    await expect(page.getByRole('note')).toHaveText('제목');
  });

  test('clear_highlight 는 하이라이트와 note 를 모두 지운다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));
    await highlight(session, [{ id: 'b1' }, { id: 'b12' }], '근거');

    expect(await clearHighlight(session)).toEqual({ cleared: true });

    await expect(overlays(page)).toHaveCount(0);
    await expect(page.getByRole('note')).toHaveCount(0);
  });

  test('새 문서를 열거나 새로고침하면 하이라이트가 비워진다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));
    await highlight(session, [{ id: 'b1' }], '근거');

    await session.open(fixturePath('application.hwpx'));
    await expect(page.getByRole('status')).toHaveText('application.hwpx — 1쪽');
    await expect(overlays(page)).toHaveCount(0);
    await expect(page.getByRole('note')).toHaveCount(0);

    await highlight(session, [{ id: 'b1' }], '근거');
    const reconnected = once(bridge.events, 'connected');
    await page.reload();
    await reconnected;
    await session.ready();
    await expect(page.getByRole('status')).toHaveText('application.hwpx — 1쪽');
    await expect(overlays(page)).toHaveCount(0);
  });
});
