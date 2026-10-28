// 뷰어 도구 막대 PDF 버튼(SPEC-008 AC-7, #109): 서버가 내준 빌드된 뷰어에서 버튼을 누르면 서버에 사람 요청(user_export_pdf)을 보내
// export_pdf 기본 경로(문서 옆 <이름>.pdf)에 저장하고, 뷰어 아래 알림에 저장한 경로를 보인다. 실패는 사람용 문구. npm run e2e 가 먼저 빌드한다.
import { chmod, copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { DocumentSessions } from '../src/server/documents.ts';
import { USER_REJECTION_MESSAGES } from '../src/shared/rejections.ts';

const viewerDir = fileURLToPath(new URL('../dist/viewer/', import.meta.url));
const fixturePath = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const SCREENS = 'test-results/screens';

let bridge: Bridge;
let sessions: DocumentSessions;
let dir: string;

test.beforeEach(async ({ page }) => {
  bridge = await startBridge({ port: 0, viewerDir });
  sessions = new DocumentSessions(bridge, { openBrowser: (url) => void page.goto(url) });
  dir = await mkdtemp(join(tmpdir(), 'docbridge-e2e-pdf-button-'));
  const source = join(dir, '공문.hwpx');
  await copyFile(fixturePath('notice.hwpx'), source);
  await sessions.open(source);
});

test.afterEach(async () => {
  await chmod(dir, 0o755);
  await bridge.close();
});

const pdfButton = (page: Page) => page.getByRole('button', { name: 'PDF 로 저장' });

test.describe('SPEC-008 뷰어 PDF 버튼 (서버가 내주는 뷰어)', () => {
  test('AC-7 도구 막대 "PDF" 버튼을 누르면 문서 옆 기본 경로에 PDF 를 저장하고 알림에 저장한 경로가 보인다', async ({ page }) => {
    const button = pdfButton(page);
    await expect(button).toHaveText('PDF');
    await expect(button).toBeEnabled();
    await page.screenshot({ path: `${SCREENS}/pdf-button-01-toolbar.png` });

    await button.click();

    const path = join(dir, '공문.pdf');
    await expect(page.getByRole('alert')).toHaveText(`PDF 로 저장했습니다: ${path}`);
    await page.screenshot({ path: `${SCREENS}/pdf-button-02-saved.png` });
    expect((await readFile(path)).subarray(0, 5).toString()).toBe('%PDF-');
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute('aria-busy', 'false');
    // 편집이 아니다: 저장하지 않은 편집 수 그대로
    expect(sessions.get().unsavedEdits).toBe(0);

    // 다시 누르면 겹치지 않게 다음 번호(save_document·export_pdf 와 같은 규칙)
    await button.click();
    await expect(page.getByRole('alert')).toHaveText(`PDF 로 저장했습니다: ${join(dir, '공문-2.pdf')}`);
  });

  test('AC-7 만드는 동안 버튼은 꺼지고(aria-disabled) aria-busy 이며, 눌러도 요청이 겹치지 않고, 끝나면 다시 켜진다', async ({ page }) => {
    const button = pdfButton(page);
    await expect(button).toBeEnabled();
    // 문서 줄을 붙잡아 내보내기가 차례를 기다리게 한다(시간에 기대지 않는다)
    let release: () => void = () => undefined;
    const held = sessions.get().exclusive(() => new Promise<void>((resolve) => (release = resolve)));

    await button.click();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toBeDisabled();
    // 진행 문구는 상태 줄에(버튼 이름·글자는 그대로)
    await expect(page.getByRole('status')).toHaveText('PDF 만드는 중…');
    await expect(button).toHaveText('PDF');
    await page.screenshot({ path: `${SCREENS}/pdf-button-03-busy.png` });
    // 꺼진 동안 누른 것은 보내지 않는다(PDF 가 하나만 생긴다)
    await button.click({ force: true });
    release();
    await held;

    await expect(page.getByRole('alert')).toHaveText(`PDF 로 저장했습니다: ${join(dir, '공문.pdf')}`);
    await expect(button).toHaveAttribute('aria-busy', 'false');
    await expect(button).toBeEnabled();
    await expect(page.getByRole('status')).toHaveText('공문.hwpx — 1쪽');
    expect(await readFile(join(dir, '공문-2.pdf')).then(() => true, () => false)).toBe(false);
  });

  test('AC-7 키보드(Enter)로 누르면 만드는 동안에도 끝난 뒤에도 포커스가 버튼에 남는다(disabled 속성이면 포커스가 빠진다)', async ({ page }) => {
    const button = pdfButton(page);
    await expect(button).toBeEnabled();
    let release: () => void = () => undefined;
    const held = sessions.get().exclusive(() => new Promise<void>((resolve) => (release = resolve)));

    await button.focus();
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toBeFocused();
    release();
    await held;

    await expect(page.getByRole('alert')).toHaveText(`PDF 로 저장했습니다: ${join(dir, '공문.pdf')}`);
    await expect(button).toBeFocused();
  });

  test('AC-7 저장하지 못하면 알림에 사람용 문구가 보인다(Claude 용 원래 문구가 아니다)', async ({ page }) => {
    const button = pdfButton(page);
    await expect(button).toBeEnabled();
    await chmod(dir, 0o555);

    await button.click();

    await expect(page.getByRole('alert')).toHaveText(USER_REJECTION_MESSAGES.export_write_failed(undefined));
    await page.screenshot({ path: `${SCREENS}/pdf-button-04-failed.png` });
    await expect(button).toBeEnabled();
  });

  test('문서를 닫은 탭(close_document)에는 PDF 버튼이 없다', async ({ page }) => {
    await expect(pdfButton(page)).toBeVisible();

    await sessions.close('d1', true);

    await expect(page.getByRole('heading', { name: '문서를 닫았습니다' })).toBeVisible();
    await expect(pdfButton(page)).toBeHidden();
  });
});
