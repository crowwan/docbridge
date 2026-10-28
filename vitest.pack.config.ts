import { defineConfig } from 'vitest/config';

// 설치판(.mcpb) 검사(SPEC-004). npm run test:pack 이 npm run pack 으로 dist/docbridge-<버전>.mcpb 를 만든 뒤 돈다.
// 묶기·풀기·서버 띄우기까지 하므로 npm test 와 따로 둔다.
export default defineConfig({
  test: {
    include: ['tests/pack/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
