// 서버(bridge + 문서 세션)가 내준 빌드된 뷰어에서 사람 편집(user_edit)과 ⌘Z(user_undo)가 서버를 거쳐
// Claude 편집과 같은 줄로 처리되는지 본다(SPEC-006 AC-6·7). 더블클릭·끌기 UI 는 #59·#60 — 여기서는 뷰어 API 로 user_edit 를 보낸다.
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { replaceText } from '../src/server/edit-tools.ts';
import { readBlockContents } from '../src/server/read-tools.ts';
import { DocumentSession } from '../src/server/session.ts';
import type { UserEdit } from '../src/shared/protocol.ts';

const viewerDir = fileURLToPath(new URL('../dist/viewer/', import.meta.url));
const fixturePath = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const SCREENS = 'test-results/screens';

const B11_BEFORE = '회신 기한: 2026. 11. 14.(금)까지 참석 인원을 회신하여 주시기 바랍니다.';
const B11_AFTER = '회신 기한: 2026. 11. 7.(금)까지 참석 인원을 회신하여 주시기 바랍니다.';

let bridge: Bridge;
let session: DocumentSession;

test.beforeEach(async ({ page }) => {
  bridge = await startBridge({ port: 0, viewerDir });
  session = new DocumentSession(bridge, { openBrowser: (url) => void page.goto(url) });
});

test.afterEach(async () => {
  await bridge.close();
});

async function paragraphText(id: string): Promise<string | undefined> {
  const [block] = (await readBlockContents(session, { ids: [id] })).blocks;
  return block?.kind === 'paragraph' ? block.text : undefined;
}

/** 뷰어가 서버에 사람 편집을 보낸다(더블클릭 UI 대신 뷰어 API) */
async function userEdit(page: Page, edit: UserEdit): Promise<void> {
  await page.evaluate(async (value) => {
    const viewer = window.docbridge;
    if (viewer === undefined) throw new Error('뷰어 API 가 없다');
    await viewer.userEdit(value);
  }, edit);
}

function anchorOf(id: string) {
  const anchor = session.document?.ids.anchor(id);
  if (anchor === undefined) throw new Error(`${id} 가 없다`);
  return anchor;
}

test.describe('SPEC-006 사람 편집 요청과 ⌘Z 공용 되돌리기 (서버가 내주는 뷰어)', () => {
  test('AC-6 뷰어가 보낸 사람 편집이 서버를 거쳐 화면에 그려지고, 서버 블록도 고친 글자다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));
    // Claude 편집 뒤 화면에서 고친다(뷰어가 편집 요청에 실려 온 문서 상태 번호를 따라가야 거부되지 않는다)
    await replaceText(session, { id: 'b1' }, '라마바구청');

    await userEdit(page, { kind: 'replace_text', target: { anchor: anchorOf('b11'), start: 13, end: 20 }, text: '11. 7.' });

    expect(await paragraphText('b11')).toBe(B11_AFTER);
    // Claude 편집과 같은 경로라 바뀐 블록 표시도 남는다
    await expect(page.getByTestId('edit-mark-0')).toBeVisible();
    expect(await paragraphText('b1')).toBe('라마바구청');
    expect(session.unsavedEdits).toBe(2);
    await page.getByRole('region', { name: '1쪽' }).screenshot({ path: `${SCREENS}/user-edit-01-replace.png` });
  });

  test('AC-7 ⌘Z 는 마지막 Claude 편집도 되돌리고, 사람 편집과 같은 줄을 차례로 되돌린다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));
    await userEdit(page, { kind: 'replace_text', target: { anchor: anchorOf('b11'), start: 13, end: 20 }, text: '11. 7.' });
    await replaceText(session, { id: 'b1' }, '라마바구청');
    await expect(page.getByTestId('edit-mark-0')).toBeVisible();

    await page.keyboard.press('ControlOrMeta+z');

    await expect.poll(() => session.editCount).toBe(1);
    expect(await paragraphText('b1')).toBe('가나다구청');
    expect(await paragraphText('b11')).toBe(B11_AFTER);

    await page.keyboard.press('ControlOrMeta+z');

    await expect.poll(() => session.editCount).toBe(0);
    expect(await paragraphText('b11')).toBe(B11_BEFORE);
    expect(session.unsavedEdits).toBe(0);
    await expect(page.getByRole('status')).toHaveText('notice.hwpx — 1쪽');
    await page.getByRole('region', { name: '1쪽' }).screenshot({ path: `${SCREENS}/user-edit-02-undo.png` });
  });

  test('되돌릴 편집이 없을 때 ⌘Z 를 누르면 상태 줄에 이유가 보이고 문서는 그대로다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));

    await page.keyboard.press('ControlOrMeta+z');

    await expect(page.getByRole('status')).toHaveText('되돌릴 편집이 없습니다.');
    expect(await paragraphText('b11')).toBe(B11_BEFORE);
  });
});
