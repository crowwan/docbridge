# docbridge

받은 한글(HWP/HWPX) 문서를 내가 쓰는 Claude 채팅에서 묻고 말로 고치는 로컬 브리지. 화면은 브라우저 뷰어(@rhwp/core).

## 개발 규칙

개인 프로젝트 공용 규칙(`~/Works/personal/_playbook/PLAYBOOK.md`)을 따른다.

- 기획: `docs/prd.md`, `docs/specs/SPEC-*.md` — 스펙이 동작의 기준. 구현 중 동작이 바뀌면 스펙부터 고친다.
- 작업: GitHub Issues + Projects. 이슈는 approved 스펙에서만 만든다 (`/spec-issues`).
- 브랜치 `<종류>/<이슈번호>-<이름>`, 커밋 `feat: 한글 메시지 (#12)`, PR 로만 머지 (squash).
- 테스트: 스펙 ID 를 테스트 묶음 이름에, AC 내용을 테스트 이름에 한글로.
- 릴리스: `/release v0.x`

## 현재 상태

- 마일스톤: v0.1
- 진행 중 스펙: SPEC-001 연결과 묻기 (in-progress, #3)
- Projects 보드: #6 (https://github.com/users/crowwan/projects/6)

## 스택

- Web (TS, Node 24). 로컬 MCP 서버(stdio, `@modelcontextprotocol/sdk`) + 같은 프로세스의 127.0.0.1 HTTP·WebSocket(`ws`, 기본 포트 7790) + 브라우저 뷰어(Vite, `@rhwp/core` 0.8.7 고정 직접 사용) — 결정과 측정값: `docs/decisions/001-stack-and-rhwp.md`
- `any`·타입 단언(`as`) 금지(`as const` 는 허용). rhwp 가 돌려주는 JSON 문자열은 zod 스키마로 읽는다
- 상대 import 는 `.ts` 확장자까지 쓴다(Node 가 TS 를 바로 실행하고, 빌드 때 `.js` 로 바뀐다)
- stdout 은 MCP 전용. 서버 로그는 `src/server/log.ts`(stderr)로만 쓴다
- 포트 3000 금지: 서버 7790, 뷰어 개발 서버 7791, E2E 개발 서버 7792
- 조사 자료: `docs/research/`

## 실행

```bash
npm ci                 # 의존성 설치 (Node 24)
npm run dev            # 뷰어 개발 서버 http://127.0.0.1:7791/?fixture=notice.hwpx
npm run build          # 서버(tsc → dist/server) + 뷰어(vite → dist/viewer)
npm start              # 빌드 결과 실행: MCP 서버(stdio) + 뷰어 서버(7790, 사용 중이면 7799 까지 다음 포트).
                       # = node dist/server/index.js. DOCBRIDGE_PORT 로 시작 포트 변경
npm run typecheck
npm test               # Vitest: 블록 추출·블록 id·하이라이트 계산·요청/응답·open_document(가짜 뷰어)·서버 통합 (CI)
npm run e2e            # 빌드 후 Playwright: 렌더링·하이라이트·측정·문서 열기·토큰 거부 (로컬 전용, CI 에 없음)
node scripts/make-fixtures.ts   # fixtures/ 의 생성 문서 다시 만들기
```

- 처음 E2E 를 돌릴 때 `npx playwright install chromium`
- 측정 결과는 `e2e-results/metrics.json`, 스크린샷은 `test-results/screens/` (둘 다 git 에 넣지 않음)

## 폴더 구조

```
src/
  server/      MCP 서버 진입점(index.ts), 도구 등록(mcp.ts), 문서 세션(session.ts: 마지막 파일·id 표·뷰어 요청 공용 경로),
               HTTP·WebSocket(bridge.ts: 토큰·포트·요청 전달), 포트 설정(port.ts), 브라우저 열기(browser.ts), stderr 로그
  shared/      서버 ↔ 뷰어 요청/응답 프로토콜(protocol.ts: 메시지 스키마·요청 id·타임아웃)
  core/        rhwp 어댑터 — 블록 추출(blocks.ts), 블록 id 대응표(block-ids.ts),
               하이라이트 사각형(highlight-rects.ts), Node 용 초기화(rhwp-node.ts)
  viewer/      브라우저 뷰어(Vite root). Canvas 렌더링 + 하이라이트 오버레이
tests/         Vitest (Node 에서 rhwp WASM 을 직접 띄움)
e2e/           Playwright (렌더링·하이라이트·측정·서버가 내주는 뷰어·문서 열기)
fixtures/      테스트용 문서와 출처(README.md)
scripts/       fixtures 생성 스크립트
docs/          PRD, 스펙, ADR(decisions/), 조사 자료(research/), QA 체크리스트
```
