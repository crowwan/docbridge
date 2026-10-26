// MCP 서버(bridge)가 내주는 빌드된 뷰어에서 rhwp WASM 이 뜨는지 본다. npm run e2e 가 먼저 빌드한다.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { startBridge } from '../src/server/bridge.ts';

const viewerDir = fileURLToPath(new URL('../dist/viewer/', import.meta.url));

test.describe('SPEC-001 서버가 내주는 뷰어 (기술 검증)', () => {
  test('127.0.0.1 서버가 내준 뷰어 페이지에서 rhwp WASM 을 불러온다', async ({ page }) => {
    const bridge = await startBridge({ port: 0, viewerDir });
    try {
      await page.goto(bridge.viewerUrl);
      const metrics = await page.evaluate(() => window.docbridge?.ready);
      expect(metrics?.wasmInitMs).toBeGreaterThan(0);
      await expect(page.getByRole('status')).toHaveText('준비됨');
    } finally {
      await bridge.close();
    }
  });
});
