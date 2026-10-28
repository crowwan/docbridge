import { defineConfig } from 'vitest/config';

// 테스트 시간 제한(#78).
// 테스트는 Node 에서 rhwp WASM 을 직접 돌린다. 파일마다 작업자(프로세스)가 따로 떠서 동시에 돌기 때문에
// 같은 테스트도 혼자 돌 때보다 몇 배 느리다 — 500 곳 바꾸기(document-editor AC-8)는 혼자 0.65초, 전체 실행 중 3.2~3.6초.
// 기본 5초 제한은 그래서 테스트가 아니라 그때 기계가 얼마나 바쁜지를 재게 되어, 바쁠 때 가끔 실패했다.
// 테스트는 시간에 기대지 않으므로(타이머는 가짜 타이머로 다룬다) 제한은 "멈춰 버린 테스트" 를 잡는 용도로만 넉넉히 둔다.
// 20초 = 관측 최대(3.6초)의 5배쯤. 더 길면 정말 멈춘 테스트가 그만큼 CI 시간을 쓴다(PR #81 리뷰).
const HANG_LIMIT_MS = 20_000;

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 설치판 검사는 npm run test:pack 으로 따로 돈다(vitest.pack.config.ts)
    exclude: ['tests/pack/**'],
    environment: 'node',
    testTimeout: HANG_LIMIT_MS,
    hookTimeout: HANG_LIMIT_MS,
  },
});
