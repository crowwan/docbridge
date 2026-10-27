// 저장(save_document)과 새로고침 확인 창을 서버가 내준 실제 브라우저 뷰어로 확인한다.
// 편집 도구(#19~#21) 대신 서버 편집 기록에 편집을 남기고 뷰어에 편집 상태(edit_state)를 보낸다 — 편집 도구가 하는 일과 같다.
import { copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HwpDocument } from '@rhwp/core';
import { expect, test, type Dialog, type Page } from '@playwright/test';
import { extractBlocks } from '../src/core/blocks.ts';
import { initRhwpForNode } from '../src/core/rhwp-node.ts';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { saveDocument } from '../src/server/save-tool.ts';
import { DocumentSession } from '../src/server/session.ts';

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

/** 브라우저는 사용자가 페이지를 한 번이라도 누른 뒤에만 확인 창을 띄운다 */
const touch = (page: Page) => page.getByTestId('page-canvas-0').click();

let bridge: Bridge;
let session: DocumentSession;
let source: string;

/** 서버 편집 기록에 편집 하나를 남기고 뷰어에 알린다 */
async function recordEdit(): Promise<void> {
  const document = session.document;
  if (document === undefined) throw new Error('열린 문서가 없습니다');
  document.edits.record('replace_text', document.ids.clone());
  await session.syncViewerEditState();
}

test.beforeEach(async ({ page }) => {
  bridge = await startBridge({ port: 0, viewerDir });
  session = new DocumentSession(bridge, { openBrowser: (url) => void page.goto(url) });
  const dir = await mkdtemp(join(tmpdir(), 'docbridge-e2e-save-'));
  source = join(dir, '공문.hwpx');
  await copyFile(fixturePath('notice.hwpx'), source);
  await session.open(source);
  await touch(page);
});

test.afterEach(async () => {
  await bridge.close();
});

test.describe('SPEC-002 새로고침 확인 창 (서버가 내주는 뷰어)', () => {
  test('저장하지 않은 편집이 있으면 탭을 닫거나 새로고침할 때 브라우저 확인 창이 뜬다', async ({ page }) => {
    await recordEdit();

    expect(await closeTab(page)).toEqual(['beforeunload']);
  });

  test('편집이 없으면 확인 창 없이 닫힌다', async ({ page }) => {
    expect(await closeTab(page)).toEqual([]);
  });

  test('저장한 뒤 되돌려 저장한 파일과 달라지면 다시 확인 창이 뜬다', async ({ page }) => {
    await recordEdit();
    await saveDocument(session, {});
    session.document?.edits.undo(1);
    await session.syncViewerEditState();

    expect(await closeTab(page)).toEqual(['beforeunload']);
  });
});

test.describe('SPEC-002 저장 (서버가 내주는 뷰어)', () => {
  test('뷰어가 내보내 검증한 HWPX 를 원본 옆에 저장하고, 저장 뒤에는 확인 창 없이 닫힌다', async ({ page }) => {
    await recordEdit();

    const result = await saveDocument(session, {});

    expect(result.path).toBe(join(source, '..', '공문-수정.hwpx'));
    expect(result.verified).toEqual({ blockCount: 14 });
    initRhwpForNode();
    const saved = new HwpDocument(new Uint8Array(await readFile(result.path)));
    expect(extractBlocks(saved)).toHaveLength(14);
    saved.free();
    await expect(page.getByRole('status')).toHaveText('공문-수정.hwpx — 1쪽');
    await page.screenshot({ path: 'test-results/screens/save-status.png' });
    expect(await closeTab(page)).toEqual([]);
  });
});
