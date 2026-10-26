import { defineConfig, devices } from '@playwright/test';

// E2E 는 CI 에 넣지 않는다(PLAYBOOK 4장). PR 전에 로컬에서 npm run e2e 로 돌린다.
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:7792',
    viewport: { width: 1000, height: 1200 },
    deviceScaleFactor: 1,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1000, height: 1200 }, deviceScaleFactor: 1 } }],
  webServer: {
    command: 'npx vite --port 7792 --strictPort',
    url: 'http://127.0.0.1:7792',
    reuseExistingServer: false,
  },
});
