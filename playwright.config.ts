import { defineConfig, devices } from '@playwright/test';
import { portFromEnv } from './src/server/port.ts';

// E2E 는 CI 에 넣지 않는다(PLAYBOOK 4장). PR 전에 로컬에서 npm run e2e 로 돌린다.
// 뷰어 개발 서버 포트는 DOCBRIDGE_E2E_PORT 로 바꿀 수 있다(여러 워크트리에서 동시에 돌릴 때). 3000 은 쓰지 않는다.
// 비어 있으면 7792, 숫자가 아니면 분명한 오류(서버의 DOCBRIDGE_PORT 와 같은 해석)
const port = portFromEnv(process.env['DOCBRIDGE_E2E_PORT'], 'DOCBRIDGE_E2E_PORT', 7792);

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1000, height: 1200 },
    deviceScaleFactor: 1,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1000, height: 1200 }, deviceScaleFactor: 1 } }],
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
