// 서버(bridge + 문서 세션)가 내준 빌드된 뷰어로 문서를 열고, 새로고침·토큰 거부·손상 파일을 확인한다.
// 브라우저 여는 함수는 Playwright 페이지 이동으로 바꿔 넣는다. npm run e2e 가 먼저 빌드한다.
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { DocumentSession } from '../src/server/session.ts';

const viewerDir = fileURLToPath(new URL('../dist/viewer/', import.meta.url));
const fixturePath = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

let bridge: Bridge;
let session: DocumentSession;
let browserOpens: string[];

function startSession(page: Page): void {
  browserOpens = [];
  session = new DocumentSession(bridge, {
    openBrowser: (url) => {
      browserOpens.push(url);
      void page.goto(url);
    },
  });
}

test.beforeEach(async ({ page }) => {
  bridge = await startBridge({ port: 0, viewerDir });
  startSession(page);
});

test.afterEach(async () => {
  await bridge.close();
});

test.describe('SPEC-001 문서 열기 (서버가 내주는 뷰어)', () => {
  for (const name of ['notice.hwpx', 'notice.hwp']) {
    test(`open_document 에 ${name} 경로를 주면 뷰어가 문서를 렌더링하고 쪽 수·블록 수를 돌려준다`, async ({ page }) => {
      const result = await session.open(fixturePath(name));

      expect(result).toEqual({ fileName: name, pageCount: 1, blockCount: 14, viewerUrl: bridge.viewerUrl });
      expect(browserOpens).toEqual([bridge.viewerUrl]);
      await expect(page.getByRole('status')).toHaveText(`${name} — 1쪽`);
      await expect(page.getByTestId('page-canvas-0')).toBeVisible();
    });
  }

  test('이미 연결된 뷰어가 있으면 새 탭을 열지 않고 그 탭의 문서를 바꾼다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));

    const second = await session.open(fixturePath('report.hwpx'));

    expect(browserOpens).toHaveLength(1);
    expect(second.pageCount).toBe(2);
    await expect(page.getByRole('status')).toHaveText('report.hwpx — 2쪽');
    await expect(page.getByRole('region', { name: /쪽$/ })).toHaveCount(2);
  });

  test('뷰어 탭을 새로고침해도 같은 문서가 다시 뜨고 블록 id 가 그대로다', async ({ page }) => {
    await session.open(fixturePath('notice.hwpx'));
    const ids = session.document?.ids;
    const reconnected = once(bridge.events, 'connected');

    await page.reload();
    await reconnected;
    await session.ready();

    await expect(page.getByRole('status')).toHaveText('notice.hwpx — 1쪽');
    await expect(page.getByTestId('page-canvas-0')).toBeVisible();
    expect(session.document?.ids).toBe(ids);
    expect(session.document?.blockCount).toBe(14);
    expect(browserOpens).toHaveLength(1);
  });

  test('rhwp 가 읽지 못하는 파일이면 이유를 돌려주고 뷰어에 오류 화면을 보여준다', async ({ page }) => {
    const path = join(await mkdtemp(join(tmpdir(), 'docbridge-broken-')), '손상된 공문.hwpx');
    await writeFile(path, 'HWPX 가 아닌 글자');

    await expect(session.open(path)).rejects.toThrow(/^문서를 열 수 없습니다: .+/);

    await expect(page.getByRole('heading', { name: '문서를 열 수 없습니다' })).toBeVisible();
    await expect(page.getByText(/^손상된 공문\.hwpx: .+/)).toBeVisible();
    await page.screenshot({ path: 'test-results/screens/open-broken-file.png' });
  });
});

test.describe('SPEC-001 토큰 없는 연결 (서버가 내주는 뷰어)', () => {
  for (const [label, query] of [
    ['토큰이 없으면', ''],
    ['토큰이 틀리면', '?token=wrong'],
  ]) {
    test(`뷰어 주소에 ${label} 연결을 거부하고 "docbridge 가 연 탭이 아닙니다" 화면을 보여준다`, async ({ page }) => {
      await page.goto(`http://127.0.0.1:${bridge.port}/${query}`);

      await expect(page.getByRole('heading', { name: 'docbridge 가 연 탭이 아닙니다' })).toBeVisible();
      expect(bridge.hasViewer()).toBe(false);
      await page.screenshot({ path: `test-results/screens/not-docbridge-tab${query === '' ? '' : '-wrong-token'}.png` });
    });
  }
});
