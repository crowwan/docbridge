// 새 문서 만들기(create_document, SPEC-003)를 서버가 내준 실제 브라우저 뷰어로 확인한다.
// 새 문서는 뷰어가 rhwp 로 만든다(서버는 양식 바이트만 보낸다). npm run e2e 가 먼저 빌드한다.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Dialog, type Page } from '@playwright/test';
import { exportVerifiedHwpx } from '../src/core/hwpx-export.ts';
import { openDocumentFile } from '../src/core/rhwp-node.ts';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { insertParagraph, replaceText } from '../src/server/edit-tools.ts';
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

let bridge: Bridge;
let session: DocumentSession;
let dir: string;

test.beforeEach(async ({ page }) => {
  bridge = await startBridge({ port: 0, viewerDir });
  session = new DocumentSession(bridge, { openBrowser: (url) => void page.goto(url) });
  dir = await mkdtemp(join(tmpdir(), 'docbridge-e2e-create-'));
});

test.afterEach(async () => {
  await bridge.close();
});

/** 첫 블록을 제목으로 채우고 그 뒤로 문단을 넣는다(스타일은 #37) */
async function fill(firstBlock: string, title: string, lines: string[]): Promise<void> {
  await replaceText(session, { id: firstBlock }, title);
  let after = firstBlock;
  for (const text of lines) after = (await insertParagraph(session, { after, text })).inserted;
}

test.describe('SPEC-003 새 문서 만들기 (서버가 내주는 뷰어)', () => {
  test('빈 문서를 뷰어에 띄우고 상태 줄에 새 문서라고 보이며, 첫 블록을 채울 수 있다', async ({ page }) => {
    const path = join(dir, '제안서.hwpx');

    const result = await session.create({ path });

    expect(result).toMatchObject({ path, pageCount: 1, blockCount: 1, firstBlock: 'b1' });
    await expect(page.getByRole('status')).toHaveText('제안서.hwpx (새 문서) — 1쪽');
    await fill(result.firstBlock, 'DocBridge 도입 제안서', ['제안 배경', '받은 한글 문서를 Claude 채팅에서 묻고 고친다.', '기대 효과']);
    await expect(page.getByTestId('page-canvas-0')).toBeVisible();
    await page.screenshot({ path: 'test-results/screens/create-blank.png' });
  });

  test('양식을 주면 양식의 머리말·꼬리말과 쪽 설정을 쓰고 본문은 빈 새 문서가 뜬다', async ({ page }) => {
    const doc = openDocumentFile(fixturePath('report.hwpx'));
    doc.createHeaderFooter(0, true, 0);
    doc.insertTextInHeaderFooter(0, true, 0, 0, 0, '가나다구청 보고서');
    doc.createHeaderFooter(0, false, 0);
    doc.insertTextInHeaderFooter(0, false, 0, 0, 0, '대외비');
    const template = join(dir, '보고서 양식.hwpx');
    await writeFile(template, exportVerifiedHwpx(doc).bytes);
    doc.free();

    const result = await session.create({ path: join(dir, '보고서.hwpx'), template });

    expect(result.template).toEqual({
      fileName: '보고서 양식.hwpx',
      removedObjects: { 표: 1 },
      keptObjects: { '구역 정의': 1, '단 정의': 1, 머리말: 1, 꼬리말: 1 },
    });
    await expect(page.getByRole('status')).toHaveText('보고서.hwpx (새 문서) — 1쪽');
    await fill(result.firstBlock, '2026년 하반기 업무 보고', ['추진 실적', '향후 계획']);
    await page.screenshot({ path: 'test-results/screens/create-template.png' });
  });
});

test.describe('SPEC-003 새 문서 확인 창 (서버가 내주는 뷰어)', () => {
  test('한 번도 저장하지 않은 새 문서는 편집이 없어도 탭을 닫거나 새로고침하면 확인 창이 뜬다', async ({ page }) => {
    await session.create({ path: join(dir, '제안서.hwpx') });
    // 브라우저는 사용자가 페이지를 한 번이라도 누른 뒤에만 확인 창을 띄운다
    await page.getByTestId('page-canvas-0').click();

    expect(await closeTab(page)).toEqual(['beforeunload']);
  });

  test('새 문서를 저장하면 확인 창 없이 닫히고 상태 줄이 저장한 파일 이름이 된다', async ({ page }) => {
    const path = join(dir, '제안서.hwpx');
    await session.create({ path });
    await page.getByTestId('page-canvas-0').click();

    expect((await saveDocument(session, {})).path).toBe(path);

    await expect(page.getByRole('status')).toHaveText('제안서.hwpx — 1쪽');
    expect(await closeTab(page)).toEqual([]);
  });
});
