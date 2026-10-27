// 끌어 옮기기와 오른쪽 클릭 메뉴(SPEC-006 AC-4·5)를 서버가 내준 실제 브라우저 뷰어로 확인한다.
// 블록 자리는 서버 하이라이트 도구로 구한다(하이라이트 사각형 = 블록 글자 자리).
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { clearHighlight, highlight } from '../src/server/highlight-tools.ts';
import { getOutline } from '../src/server/read-tools.ts';
import { DocumentSession } from '../src/server/session.ts';

const viewerDir = fileURLToPath(new URL('../dist/viewer/', import.meta.url));
const fixturePath = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const SCREENS = 'test-results/screens';

let bridge: Bridge;
let session: DocumentSession;

test.beforeEach(async ({ page }) => {
  bridge = await startBridge({ port: 0, viewerDir });
  session = new DocumentSession(bridge, { openBrowser: (url) => void page.goto(url) });
});

test.afterEach(async () => {
  await bridge.close();
});

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 블록 자리(첫 사각형)의 화면 좌표 */
async function boxOf(page: Page, id: string): Promise<Box> {
  await highlight(session, [{ id }]);
  const box = await page.getByTestId('highlight-0').boundingBox();
  if (box === null) throw new Error(`${id} 자리가 없다`);
  await clearHighlight(session);
  return box;
}

const center = ({ x, y, width, height }: Box) => ({ x: x + width / 2, y: y + height / 2 });

/** 개요의 "id 번호" 차례 */
async function outline(): Promise<string[]> {
  return (await getOutline(session)).blocks.map(({ id, number }) => (number === undefined ? id : `${id} ${number}`));
}

const menu = (page: Page) => page.getByRole('menu', { name: '블록' });
const item = (page: Page, name: string) => page.getByRole('menuitem', { name });
const firstPage = (page: Page) => page.getByRole('region', { name: '1쪽' });

async function rightClick(page: Page, id: string): Promise<void> {
  const { x, y } = center(await boxOf(page, id));
  await page.mouse.click(x, y, { button: 'right' });
  await expect(menu(page)).toBeVisible();
}

test.describe('SPEC-006 끌어 옮기기와 오른쪽 클릭 메뉴 (서버가 내주는 뷰어)', () => {
  test('AC-4 문단을 끌어 놓으면 옮겨지고 번호가 다시 매겨진다. 끄는 동안 놓일 자리에 가로선이 보인다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));
    const from = center(await boxOf(page, 'b11'));
    const target = await boxOf(page, 'b6');

    // "3. 회신 기한" 을 "1. 관련" 위 절반으로
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(target.x + 20, target.y + 2, { steps: 8 });
    await expect(page.getByTestId('drop-line')).toBeVisible();
    const lineBox = await page.getByTestId('drop-line').boundingBox();
    // 가로선은 b5 와 b6 사이(b6 위)
    expect(lineBox?.y).toBeLessThanOrEqual(target.y + 1);
    await firstPage(page).screenshot({ path: `${SCREENS}/block-01-drag-line.png` });
    await page.mouse.up();

    await expect.poll(() => session.editCount).toBe(1);
    await expect(page.getByTestId('drop-line')).toHaveCount(0);
    expect((await outline()).slice(5, 8)).toEqual(['b11 1.', 'b6 2.', 'b7 3.']);
    await expect(page.getByTestId('edit-mark-0')).toBeVisible();
    await firstPage(page).screenshot({ path: `${SCREENS}/block-02-dropped.png` });
  });

  test('끄는 동안 Esc 면 놓아도 바뀌지 않고, 제자리(바로 앞·뒤)에 놓으면 편집이 없다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));
    const before = await outline();
    const from = center(await boxOf(page, 'b11'));
    const target = await boxOf(page, 'b6');

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(target.x + 20, target.y + 2, { steps: 8 });
    await expect(page.getByTestId('drop-line')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('drop-line')).toHaveCount(0);
    await page.mouse.up();

    // 제자리: b11 을 조금만 아래로(자기 아래 절반)
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y + 4, { steps: 4 });
    await expect(page.getByTestId('drop-line')).toHaveCount(0);
    await page.mouse.up();

    await page.getByRole('heading', { name: 'docbridge' }).click();
    expect(session.editCount).toBe(0);
    expect(await outline()).toEqual(before);
  });

  test('AC-5 오른쪽 클릭 메뉴로 지우기', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));

    await rightClick(page, 'b8');
    await expect(item(page, '지우기')).toBeVisible();
    await page.screenshot({ path: `${SCREENS}/block-03-menu.png` });
    await item(page, '지우기').click();

    await expect(menu(page)).toHaveCount(0);
    await expect.poll(() => session.editCount).toBe(1);
    const after = await outline();
    expect(after.some((entry) => entry.startsWith('b8'))).toBe(false);
    // "나. 교육 내용" 이 "가." 로 다시 매겨진다
    expect(after).toContain('b9 가.');
  });

  test('AC-5 오른쪽 클릭 메뉴로 위로·아래로(앞·뒤 블록 기준 move_blocks)', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));

    await rightClick(page, 'b10');
    await item(page, '위로').click();
    await expect.poll(() => session.editCount).toBe(1);
    expect((await outline()).slice(7, 10)).toEqual(['b8 가.', 'b10 나.', 'b9 다.']);

    await rightClick(page, 'b8');
    await item(page, '아래로').click();
    await expect.poll(() => session.editCount).toBe(2);
    expect((await outline()).slice(7, 10)).toEqual(['b10 가.', 'b8 나.', 'b9 다.']);
  });

  test('AC-5 메뉴는 키보드로 연다(Shift+F10·메뉴 키) — 화살표로 고르고 Enter 로 하고 Esc 로 닫는다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));
    const b9 = center(await boxOf(page, 'b9'));
    await page.mouse.move(b9.x, b9.y);

    await page.keyboard.press('Shift+F10');
    await expect(menu(page)).toBeVisible();
    await expect(item(page, '위로')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);

    await page.keyboard.press('ContextMenu');
    await expect(item(page, '위로')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item(page, '아래로')).toBeFocused();
    await page.keyboard.press('End');
    await expect(item(page, '지우기')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item(page, '위로')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    await expect.poll(() => session.editCount).toBe(1);
    expect((await outline()).slice(7, 10)).toEqual(['b8 가.', 'b10 나.', 'b9 다.']);
  });

  test('AC-5 첫 블록은 위로가 꺼져 있고, 거부되는 블록(구역 첫 문단 지우기)은 문구만 3초 보이고 바뀌지 않는다', async ({ page }) => {
    await page.clock.install();
    await session.open(fixturePath('notice.hwpx'));
    const before = await outline();

    await rightClick(page, 'b1');
    await expect(item(page, '위로')).toHaveAttribute('aria-disabled', 'true');
    await expect(item(page, '아래로')).toBeFocused();
    await item(page, '지우기').click();

    await expect(page.getByRole('alert')).toContainText('구역 첫 문단은 지울 수 없습니다');
    await page.screenshot({ path: `${SCREENS}/block-04-rejected.png` });
    expect(session.editCount).toBe(0);
    expect(await outline()).toEqual(before);
    await page.clock.runFor(3000);
    await expect(page.getByRole('alert')).toBeHidden();
  });

  test('표는 칸 위를 끌어도 표째 옮긴다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));
    const table = center(await boxOf(page, 'b12'));
    const target = await boxOf(page, 'b11');

    await page.mouse.move(table.x, table.y);
    await page.mouse.down();
    await page.mouse.move(target.x + 20, target.y + 2, { steps: 8 });
    await page.mouse.up();

    await expect.poll(() => session.editCount).toBe(1);
    expect((await outline()).slice(10, 12)).toEqual(['b12', 'b11 3.']);
  });
});
