// 저장(save_document)과 새로고침 확인 창을 서버가 내준 실제 브라우저 뷰어로 확인한다.
// 확인 창은 서버 편집 기록의 저장하지 않은 편집 수(edit_state)를 따른다. npm run e2e 가 먼저 빌드한다.
import { copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HwpDocument } from '@rhwp/core';
import { expect, test, type Dialog, type Page } from '@playwright/test';
import { extractBlocks } from '../src/core/blocks.ts';
import { initRhwpForNode } from '../src/core/rhwp-node.ts';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { replaceText, undo } from '../src/server/edit-tools.ts';
import { saveDocument } from '../src/server/save-tool.ts';
import { DocumentSessions } from '../src/server/documents.ts';

const viewerDir = fileURLToPath(new URL('../dist/viewer/', import.meta.url));
const fixturePath = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

/** 탭을 닫아 본다(beforeunload 실행). 확인 창이 뜨면 그 종류를 돌려주고 닫기를 허락한다 */
async function closeTab(page: Page): Promise<string[]> {
  const dialogs: string[] = [];
  page.on('dialog', (dialog: Dialog) => {
    dialogs.push(dialog.type());
    void dialog.accept();
  });
  const closed = page.waitForEvent('close');
  await page.close({ runBeforeUnload: true });
  await closed;
  return dialogs;
}

let bridge: Bridge;
let sessions: DocumentSessions;
let source: string;

/** notice.hwpx b11 = "회신 기한: 2026. 11. 14.(금)까지 …" */
const edit = () => replaceText(sessions.get(), { id: 'b11', start: 13, end: 20 }, '11. 7.');

test.beforeEach(async ({ page }) => {
  bridge = await startBridge({ port: 0, viewerDir });
  sessions = new DocumentSessions(bridge, { openBrowser: (url) => void page.goto(url) });
  const dir = await mkdtemp(join(tmpdir(), 'docbridge-e2e-save-'));
  source = join(dir, '공문.hwpx');
  await copyFile(fixturePath('notice.hwpx'), source);
  await sessions.open(source);
  // 브라우저는 사용자가 페이지를 한 번이라도 누른 뒤에만 확인 창을 띄운다
  await page.getByTestId('page-canvas-0').click();
});

test.afterEach(async () => {
  await bridge.close();
});

test.describe('SPEC-002 새로고침 확인 창 (서버가 내주는 뷰어)', () => {
  test('replace_text 뒤 탭을 닫거나 새로고침하면 브라우저 확인 창이 뜬다', async ({ page }) => {
    await edit();

    expect(await closeTab(page)).toEqual(['beforeunload']);
  });

  test('편집이 없으면 확인 창 없이 닫힌다', async ({ page }) => {
    expect(await closeTab(page)).toEqual([]);
  });

  test('편집한 뒤 저장하면 확인 창 없이 닫힌다', async ({ page }) => {
    await edit();
    await saveDocument(sessions.get(), {});

    expect(await closeTab(page)).toEqual([]);
  });

  test('저장한 뒤 undo 해서 저장한 파일과 달라지면 다시 확인 창이 뜬다', async ({ page }) => {
    await edit();
    await saveDocument(sessions.get(), {});
    await undo(sessions.get(), 1);

    expect(await closeTab(page)).toEqual(['beforeunload']);
  });
});

test.describe('SPEC-002 저장 (서버가 내주는 뷰어)', () => {
  test('뷰어가 내보내 검증한 HWPX 를 원본 옆에 저장하고 상태 줄이 저장한 파일 이름이 된다', async ({ page }) => {
    await edit();

    const result = await saveDocument(sessions.get(), {});

    expect(result.path).toBe(join(source, '..', '공문-수정.hwpx'));
    expect(result.verified).toEqual({ blockCount: 14 });
    initRhwpForNode();
    const saved = new HwpDocument(new Uint8Array(await readFile(result.path)));
    const texts = extractBlocks(saved).map((block) => (block.kind === 'paragraph' ? block.text : ''));
    saved.free();
    expect(texts).toContain('회신 기한: 2026. 11. 7.(금)까지 참석 인원을 회신하여 주시기 바랍니다.');
    await expect(page.getByRole('status')).toHaveText('공문-수정.hwpx — 1쪽');
    await page.screenshot({ path: 'test-results/screens/save-status.png' });
  });
});
