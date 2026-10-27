// 더블클릭으로 문단·칸·누름틀 글자 고치기(SPEC-006 AC-1·2·3·8)를 서버가 내준 실제 브라우저 뷰어로 확인한다.
// 고칠 자리는 서버 하이라이트 도구로 그 블록 자리를 구해 그 가운데를 더블클릭한다(하이라이트 사각형 = 블록 글자 자리).
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HwpDocument } from '@rhwp/core';
import { expect, test, type Page } from '@playwright/test';
import { z } from 'zod';
import { BLOCK_CHANGED_WHILE_EDITING, CROSSES_FIELD_IN_VIEWER } from '../src/core/edit-spot.ts';
import { openDocumentFile } from '../src/core/rhwp-node.ts';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { replaceText } from '../src/server/edit-tools.ts';
import { clearHighlight, highlight } from '../src/server/highlight-tools.ts';
import { readBlockContents } from '../src/server/read-tools.ts';
import { saveDocument } from '../src/server/save-tool.ts';
import { DocumentSessions } from '../src/server/documents.ts';
import type { TextTarget } from '../src/shared/protocol.ts';

const viewerDir = fileURLToPath(new URL('../dist/viewer/', import.meta.url));
const fixturePath = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const SCREENS = 'test-results/screens';

const B11_BEFORE = '회신 기한: 2026. 11. 14.(금)까지 참석 인원을 회신하여 주시기 바랍니다.';
const B11_AFTER = '회신 기한: 2026. 11. 7.(금)까지 참석 인원을 회신하여 주시기 바랍니다.';

let bridge: Bridge;
let sessions: DocumentSessions;

test.beforeEach(async ({ page }) => {
  bridge = await startBridge({ port: 0, viewerDir });
  sessions = new DocumentSessions(bridge, { openBrowser: (url) => void page.goto(url) });
});

test.afterEach(async () => {
  await bridge.close();
});

const editBox = (page: Page) => page.getByRole('textbox', { name: '블록 글자 고치기' });
const firstPage = (page: Page) => page.getByRole('region', { name: '1쪽' });

async function blockText(id: string, cell?: { row: number; col: number }): Promise<string | undefined> {
  const [block] = (await readBlockContents(sessions.get(), { ids: [id] })).blocks;
  if (block?.kind === 'paragraph') return block.text;
  if (block?.kind === 'field') return block.value;
  if (block?.kind === 'table') return block.cells.find((c) => c.row === cell?.row && c.col === cell.col)?.text;
  return undefined;
}

/** 대상 자리(첫 사각형) 가운데의 화면 좌표. keep 이 아니면 구한 뒤 하이라이트를 지운다 */
async function centerOf(page: Page, target: TextTarget, keep = false): Promise<{ x: number; y: number }> {
  await highlight(sessions.get(), [target]);
  const box = await page.getByTestId('highlight-0').boundingBox();
  if (box === null) throw new Error('하이라이트 자리가 없다');
  if (!keep) await clearHighlight(sessions.get());
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function doubleClick(page: Page, target: TextTarget, keep = false): Promise<void> {
  const { x, y } = await centerOf(page, target, keep);
  await page.mouse.dblclick(x, y);
}

/** 화면에서 b7 을 고쳐 적용될 때까지 기다린다. 뷰어 → 서버 메시지는 차례대로라, 앞서 보낸 요청이 있었다면 이미 처리됐다 */
async function editB7(page: Page): Promise<void> {
  await doubleClick(page, { id: 'b7' });
  await editBox(page).fill(`${await editBox(page).inputValue()}!`);
  await page.keyboard.press('Enter');
  await expect.poll(() => blockText('b7')).toMatch(/!$/);
}

/** b11 의 "2026" 과 "바랍니다" 를 굵게 한 notice.hwpx 사본(부분 서식이 남는지 본다) */
async function boldCopy(): Promise<string> {
  const doc = openDocumentFile(fixturePath('notice.hwpx'));
  doc.applyCharFormat(0, 10, 7, 11, JSON.stringify({ bold: true }));
  const end = [...B11_BEFORE].length;
  doc.applyCharFormat(0, 10, end - 5, end - 1, JSON.stringify({ bold: true }));
  const path = join(await mkdtemp(join(tmpdir(), 'docbridge-e2e-dblclick-')), '굵게.hwpx');
  await writeFile(path, doc.exportHwpx());
  doc.free();
  return path;
}

const boldSchema = z.looseObject({ bold: z.boolean() });

test.describe('SPEC-006 더블클릭으로 글자 고치기 (서버가 내주는 뷰어)', () => {
  test('AC-1 문단을 더블클릭해 글자를 고치고 Enter 하면 바뀌고, 앞뒤 같은 글자의 굵게가 남는다', async ({ page }) => {
    await sessions.open(await boldCopy());
    const { x, y } = await centerOf(page, { id: 'b11' });

    // 고칠 수 있는 블록에 마우스를 올리면 옅은 테두리
    await page.mouse.move(x, y);
    await expect(page.getByTestId('edit-hover')).toBeVisible();
    await firstPage(page).screenshot({ path: `${SCREENS}/dblclick-01-hover.png` });

    await page.mouse.dblclick(x, y);
    await expect(editBox(page)).toHaveValue(B11_BEFORE);
    await expect(editBox(page)).toBeFocused();
    await editBox(page).fill(B11_AFTER);
    await firstPage(page).screenshot({ path: `${SCREENS}/dblclick-02-input.png` });
    await page.keyboard.press('Enter');

    await expect(editBox(page)).toBeHidden();
    await expect.poll(() => blockText('b11')).toBe(B11_AFTER);
    await expect(page.getByTestId('edit-mark-0')).toBeVisible();
    await firstPage(page).screenshot({ path: `${SCREENS}/dblclick-03-applied.png` });

    const saved = await saveDocument(sessions.get(), {});
    const doc = new HwpDocument(new Uint8Array(await readFile(saved.path)));
    const boldAt = (offset: number) => boldSchema.parse(JSON.parse(doc.getCharPropertiesAt(0, 10, offset))).bold;
    const end = [...B11_AFTER].length;
    // "2026"(7~10)·"바랍니다"(끝 5~2) 굵게는 그대로, 바꾼 "7" 은 바뀌던 자리 첫 글자("1", 보통) 모양
    expect([boldAt(7), boldAt(10), boldAt(end - 5), boldAt(end - 2)]).toEqual([true, true, true, true]);
    expect(boldAt(17)).toBe(false);
    doc.free();
  });

  test('AC-2 Esc 면 취소하고, 같은 글자로 Enter 해도 편집이 생기지 않는다', async ({ page }) => {
    await sessions.open(fixturePath('notice.hwpx'));

    await doubleClick(page, { id: 'b11' });
    await editBox(page).fill('지울 글자');
    await page.keyboard.press('Escape');
    await expect(editBox(page)).toBeHidden();

    await doubleClick(page, { id: 'b11' });
    await expect(editBox(page)).toHaveValue(B11_BEFORE);
    await page.keyboard.press('Enter');
    await expect(editBox(page)).toBeHidden();

    // 다음 사람 편집이 적용될 때 앞서 보낸 것이 있었다면 이미 처리됐다 — 편집은 b7 하나뿐이다
    await editB7(page);
    expect(sessions.editCount).toBe(1);
    expect(sessions.unsavedEdits).toBe(1);
    expect(await blockText('b11')).toBe(B11_BEFORE);
  });

  test('줄바꿈(Shift+Enter)은 받지 않고, 입력칸 바깥을 누르면 적용한다', async ({ page }) => {
    await sessions.open(fixturePath('notice.hwpx'));
    const before = await blockText('b8');

    await doubleClick(page, { id: 'b8' });
    await page.keyboard.press('End');
    await page.keyboard.type(' 등');
    await page.keyboard.press('Shift+Enter');
    await expect(editBox(page)).toHaveValue(`${before} 등`);

    await page.getByRole('heading', { name: 'docbridge' }).click();

    await expect(editBox(page)).toBeHidden();
    await expect.poll(() => blockText('b8')).toBe(`${before} 등`);
  });

  test('AC-3 표 칸을 더블클릭해 그 칸 글자만 고친다', async ({ page }) => {
    await sessions.open(fixturePath('notice.hwpx'));
    const cell = { row: 1, col: 1 };
    const before = await blockText('b12', cell);

    await doubleClick(page, { id: 'b12', cell });
    await expect(editBox(page)).toHaveValue(before ?? '');
    await page.keyboard.press('End');
    await page.keyboard.type(' (변경)');
    await firstPage(page).screenshot({ path: `${SCREENS}/dblclick-04-cell.png` });
    await page.keyboard.press('Enter');

    await expect.poll(() => blockText('b12', cell)).toBe(`${before} (변경)`);
  });

  test('AC-3 누름틀을 더블클릭해 값을 고친다(빈 누름틀은 안내문 자리)', async ({ page }) => {
    await sessions.open(fixturePath('notice.hwpx'));

    await doubleClick(page, { id: 'b3' });
    await expect(editBox(page)).toHaveValue('');
    await page.keyboard.type('각 동 주민센터');
    await page.keyboard.press('Enter');
    await expect.poll(() => blockText('b3')).toBe('각 동 주민센터');

    // 값이 있는 누름틀도 값 위를 더블클릭하면 값만 고친다
    await doubleClick(page, { id: 'b3' });
    await expect(editBox(page)).toHaveValue('각 동 주민센터');
    await editBox(page).fill('각 동 행정복지센터');
    await page.keyboard.press('Enter');
    await expect.poll(() => blockText('b3')).toBe('각 동 행정복지센터');
    expect(await blockText('b2')).toBe('수신  각 동 행정복지센터');
    await firstPage(page).screenshot({ path: `${SCREENS}/dblclick-05-field.png` });
  });

  test('문단 입력칸에서 누름틀 값과 그 바깥을 한 번에 고치면 보내지 않고 뷰어 아래 알림이 3초 보인다', async ({ page }) => {
    await page.clock.install();
    await sessions.open(fixturePath('notice.hwpx'));
    await replaceText(sessions.get(), { id: 'b3' }, '각 동 주민센터');

    await doubleClick(page, { id: 'b2', start: 0, end: 2 });
    await expect(editBox(page)).toHaveValue('수신  각 동 주민센터');
    await editBox(page).fill('받는 곳 서 동 주민센터');
    await page.keyboard.press('Enter');

    await expect(page.getByRole('alert')).toHaveText(CROSSES_FIELD_IN_VIEWER);
    await page.screenshot({ path: `${SCREENS}/dblclick-06-toast.png` });
    expect(sessions.editCount).toBe(1);
    await page.clock.runFor(3000);
    await expect(page.getByRole('alert')).toBeHidden();
  });

  test('AC-8 입력칸이 열린 동안 Claude 가 같은 블록을 바꾸면(서버 기록 전이어도) 사람 적용은 거부되고 알림이 보인다', async ({ page }) => {
    // 뷰어가 Claude 편집에 보내는 응답을 붙잡는다 — 뷰어는 적용해 다시 그렸지만 서버는 아직 기록하지 않은 사이
    let holdEdit = false;
    let release: (() => void) | undefined;
    await page.routeWebSocket(/\?token=/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        const data: unknown = typeof message === 'string' ? JSON.parse(message) : undefined;
        const response = z.object({ type: z.literal('response'), result: z.object({ changed: z.array(z.unknown()) }) }).safeParse(data);
        if (holdEdit && response.success) {
          holdEdit = false;
          release = () => server.send(message);
          return;
        }
        server.send(message);
      });
    });
    await sessions.open(fixturePath('notice.hwpx'));

    await doubleClick(page, { id: 'b11' });
    await editBox(page).fill(B11_AFTER);
    holdEdit = true;
    const claude = replaceText(sessions.get(), { id: 'b11', start: 0, end: 5 }, '회신 마감');
    await expect.poll(() => release !== undefined).toBe(true);

    // Claude 편집이 와도 입력칸은 닫히지 않는다
    await expect(editBox(page)).toBeFocused();
    await expect(editBox(page)).toHaveValue(B11_AFTER);
    await page.keyboard.press('Enter');

    await expect(page.getByRole('alert')).toHaveText(BLOCK_CHANGED_WHILE_EDITING);
    await page.screenshot({ path: `${SCREENS}/dblclick-07-conflict.png` });
    release?.();
    await claude;
    expect(await blockText('b11')).toBe(B11_BEFORE.replace('회신 기한', '회신 마감'));
    expect(sessions.editCount).toBe(1);
  });

  test('입력칸이 열린 동안 Claude 가 다른 블록을 바꿔도 입력칸은 그대로이고, 적용하면 고친 블록에 들어간다', async ({ page }) => {
    await sessions.open(fixturePath('notice.hwpx'));

    await doubleClick(page, { id: 'b11' });
    await editBox(page).fill(B11_AFTER);
    await replaceText(sessions.get(), { id: 'b1' }, '라마바구청');
    await expect(editBox(page)).toBeFocused();
    await page.keyboard.press('Enter');

    await expect.poll(() => blockText('b11')).toBe(B11_AFTER);
    expect(await blockText('b1')).toBe('라마바구청');
    expect(sessions.editCount).toBe(2);
  });

  test('하이라이트가 있는 블록을 고치면 그 하이라이트는 지운다', async ({ page }) => {
    await sessions.open(fixturePath('notice.hwpx'));

    await doubleClick(page, { id: 'b11' }, true);
    await expect(page.getByTestId('highlight-0')).toBeVisible();
    await editBox(page).fill(B11_AFTER);
    await page.keyboard.press('Enter');

    await expect.poll(() => blockText('b11')).toBe(B11_AFTER);
    await expect(page.getByTestId('highlight-0')).toHaveCount(0);
  });

  test('연결이 끊겨 있으면 고치지 않고 알림이 보인다', async ({ page }) => {
    let connection: { close: () => Promise<void> } | undefined;
    await page.routeWebSocket(/\?token=/, (ws) => {
      ws.connectToServer();
      connection = ws;
    });
    await sessions.open(fixturePath('notice.hwpx'));
    const { x, y } = await centerOf(page, { id: 'b11' });
    await connection?.close();
    await expect(page.getByRole('status')).toContainText('연결이 끊겼습니다');

    await page.mouse.dblclick(x, y);
    await editBox(page).fill(B11_AFTER);
    await page.keyboard.press('Enter');

    await expect(page.getByRole('alert')).toHaveText('docbridge 와 연결이 끊겨 고칠 수 없습니다');
  });
});
