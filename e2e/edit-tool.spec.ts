// 서버(bridge + 문서 세션)가 내준 빌드된 뷰어에서 replace_text · move_blocks · undo 가 화면을 다시 그리고
// 바뀐 블록에 초록 테두리를 남기는지, 다음 편집·하이라이트 때 지워지는지 본다(SPEC-002 AC-7). npm run e2e 가 먼저 빌드한다.
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { deleteBlocks, insertParagraph, moveBlocks, replaceText, undo } from '../src/server/edit-tools.ts';
import { highlight } from '../src/server/highlight-tools.ts';
import { readBlockContents } from '../src/server/read-tools.ts';
import { DocumentSession } from '../src/server/session.ts';
import { inkBounds } from './viewer.ts';

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

// 바뀐 블록 표시는 캔버스 위 장식이라 역할·글자가 없다 → 클래스·testid 로 찾는다(PLAYBOOK 4장 예외)
const marks = (page: Page) => page.locator('.edit-mark');

async function paragraphText(id: string): Promise<string | undefined> {
  const [block] = (await readBlockContents(session, { ids: [id] })).blocks;
  return block?.kind === 'paragraph' ? block.text : undefined;
}

/** 표시 하나의 쪽 캔버스 기준 위치 */
async function markOnFirstPage(page: Page, index: number) {
  const box = await page.getByTestId(`edit-mark-${index}`).boundingBox();
  const pageBox = await page.getByTestId('page-canvas-0').boundingBox();
  if (!box || !pageBox) throw new Error('표시나 쪽이 화면에 없다');
  return { left: box.x - pageBox.x, top: box.y - pageBox.y, right: box.x - pageBox.x + box.width, bottom: box.y - pageBox.y + box.height };
}

test.describe('SPEC-002 편집 뒤 다시 그리기와 바뀐 블록 표시 (서버가 내주는 뷰어)', () => {
  test('AC-7 replace_text 뒤 뷰어가 다시 그려지고 바뀐 문단을 초록 테두리가 감싼다. undo 하면 원래 글자로 돌아가고 표시가 없다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));
    const firstPage = page.getByRole('region', { name: '1쪽' });
    await firstPage.screenshot({ path: `${SCREENS}/edit-01-before.png` });

    const result = await replaceText(session, { id: 'b11', start: 13, end: 20 }, '11. 7.');

    expect(result.changed.map(({ id }) => id)).toEqual(['b11']);
    expect(await paragraphText('b11')).toBe('회신 기한: 2026. 11. 7.(금)까지 참석 인원을 회신하여 주시기 바랍니다.');
    await expect(marks(page)).toHaveCount(1);
    await expect(page.getByTestId('edit-mark-0')).toBeVisible();
    // 표시 안에 바뀐 문단 글자가 있고, 테두리는 개인 DS success 초록이다
    const mark = await markOnFirstPage(page, 0);
    expect(await inkBounds(page, 0, mark)).not.toBeNull();
    await expect(page.getByTestId('edit-mark-0')).toHaveCSS('outline-color', 'rgb(30, 166, 114)');
    await expect(page.getByRole('status')).toHaveText('notice.hwpx — 1쪽');
    await firstPage.screenshot({ path: `${SCREENS}/edit-02-after-replace.png` });

    expect(await undo(session, 1)).toEqual({ undone: 1, edits: ['replace_text b11'] });

    expect(await paragraphText('b11')).toBe('회신 기한: 2026. 11. 14.(금)까지 참석 인원을 회신하여 주시기 바랍니다.');
    await expect(marks(page)).toHaveCount(0);
    await firstPage.screenshot({ path: `${SCREENS}/edit-03-after-undo.png` });
  });

  test('AC-7 다음 편집을 하면 이전 표시는 지워지고 새로 바뀐 블록(표)만 표시한다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));
    await replaceText(session, { id: 'b1' }, '라마바구청');
    const paragraphMark = await markOnFirstPage(page, 0);

    await replaceText(session, { id: 'b12', cell: { row: 2, col: 2 } }, '구민회관 3층 강당');

    await expect(marks(page)).toHaveCount(1);
    const tableMark = await markOnFirstPage(page, 0);
    expect(tableMark.top).toBeGreaterThan(paragraphMark.bottom);
    // 표 전체를 감싼다(칸 하나보다 크다)
    expect(tableMark.bottom - tableMark.top).toBeGreaterThan(paragraphMark.bottom - paragraphMark.top);
    await page.getByRole('region', { name: '1쪽' }).screenshot({ path: `${SCREENS}/edit-04-table-cell.png` });
  });

  test('누름틀 값을 바꾸면 같은 문단도 바뀐 블록이고, 문단 테두리 하나로 감싼다(문단 안 누름틀 테두리는 겹쳐 그리지 않는다)', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));

    const result = await replaceText(session, { id: 'b3' }, '각 동 주민센터');

    expect(result.changed.map(({ id }) => id)).toEqual(['b2', 'b3']);
    await expect(marks(page)).toHaveCount(1);
    await page.getByRole('region', { name: '1쪽' }).screenshot({ path: `${SCREENS}/edit-05-field.png` });
  });

  test('새 문서를 열면 보던 자리와 상관없이 맨 위부터 보인다 (PR #26 리뷰)', async ({ page }) => {
    await session.open(fixturePath('report.hwpx'));
    await page.evaluate(() => window.scrollTo(0, 800));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    await session.open(fixturePath('report.hwpx'));

    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('AC-7 하이라이트를 그리면 바뀐 블록 표시는 지워진다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));
    await replaceText(session, { id: 'b1' }, '라마바구청');
    await expect(marks(page)).toHaveCount(1);

    await highlight(session, [{ id: 'b5' }]);

    await expect(marks(page)).toHaveCount(0);
    await expect(page.locator('.highlight')).not.toHaveCount(0);
  });
});

test.describe('SPEC-002 문단 넣기·지우기 화면 (서버가 내주는 뷰어)', () => {
  test('AC-2 insert_paragraph 뒤 넣은 문단이 그려지고 초록 테두리가 감싼다. 뒤 블록은 아래로 밀린다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));
    const firstPage = page.getByRole('region', { name: '1쪽' });

    const result = await insertParagraph(session, { after: 'b11', text: '문의: 안전총괄과(02-123-4567)' });

    expect(result).toEqual({ inserted: 'b15', changed: [{ id: 'b15', text: '문의: 안전총괄과(02-123-4567)' }] });
    expect(await paragraphText('b15')).toBe('문의: 안전총괄과(02-123-4567)');
    await expect(marks(page)).toHaveCount(1);
    const mark = await markOnFirstPage(page, 0);
    expect(await inkBounds(page, 0, mark)).not.toBeNull();
    await firstPage.screenshot({ path: `${SCREENS}/insert-01-after-insert.png` });
  });

  test('AC-3 delete_blocks 뒤 지운 문단·표가 화면에서 사라지고, 지운 블록에는 표시가 없고 번호가 바뀐 문단에만 남는다. undo 하면 돌아온다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));
    const firstPage = page.getByRole('region', { name: '1쪽' });
    await insertParagraph(session, { after: 'b1', text: '넣은 문단' });
    await expect(marks(page)).toHaveCount(1);

    expect(await deleteBlocks(session, ['b8', 'b10', 'b12'])).toEqual({ deleted: ['b8', 'b10', 'b12'] });

    // "나. 교육 내용" 이 "가." 로 다시 매겨져 그 문단만 바뀐 블록이다(#21)
    await expect(marks(page)).toHaveCount(1);
    expect((await readBlockContents(session, { fromPage: 1 })).blocks.map(({ kind }) => kind)).not.toContain('table');
    await firstPage.screenshot({ path: `${SCREENS}/insert-02-after-delete.png` });

    expect(await undo(session, 1)).toEqual({ undone: 1, edits: ['delete_blocks b8, b10, b12'] });
    expect((await readBlockContents(session, { ids: ['b12'] })).blocks.map(({ kind }) => kind)).toEqual(['table']);
  });

  test('AC-4 move_blocks 뒤 옮긴 문단과 번호가 바뀐 문단이 다시 그려지고 초록 테두리가 남는다. undo 하면 번호가 돌아오고 표시가 없다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));
    const firstPage = page.getByRole('region', { name: '1쪽' });
    await firstPage.screenshot({ path: `${SCREENS}/move-01-before.png` });

    // "3. 회신 기한" 을 "1. 관련" 앞으로
    const result = await moveBlocks(session, { ids: ['b11'], before: 'b6' });

    expect(result.changed.map(({ id, number }) => `${id} ${number}`)).toEqual(['b11 1.', 'b6 2.', 'b7 3.']);
    await expect(marks(page)).toHaveCount(3);
    // 표시는 문서 순서: 옮긴 문단(맨 위) → 번호가 바뀐 문단들
    const [moved, first, second] = [await markOnFirstPage(page, 0), await markOnFirstPage(page, 1), await markOnFirstPage(page, 2)];
    expect(moved.bottom).toBeLessThanOrEqual(first.top + 1);
    expect(first.bottom).toBeLessThanOrEqual(second.top + 1);
    expect(await inkBounds(page, 0, moved)).not.toBeNull();
    await firstPage.screenshot({ path: `${SCREENS}/move-02-after.png` });

    expect(await undo(session, 1)).toEqual({ undone: 1, edits: ['move_blocks b11'] });

    await expect(marks(page)).toHaveCount(0);
    expect(await paragraphText('b11')).toBe('회신 기한: 2026. 11. 14.(금)까지 참석 인원을 회신하여 주시기 바랍니다.');
    await firstPage.screenshot({ path: `${SCREENS}/move-03-after-undo.png` });
  });
});
