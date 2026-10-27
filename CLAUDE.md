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
- 진행 중 스펙: SPEC-001 연결과 묻기 (in-progress, #3), SPEC-002 말로 고치기와 저장 (in-progress, #17), SPEC-003 새 문서 만들기 (in-progress, #34, v0.2)
- Projects 보드: #6 (https://github.com/users/crowwan/projects/6)

## 스택

- Web (TS, Node 24). 로컬 MCP 서버(stdio, `@modelcontextprotocol/sdk`) + 같은 프로세스의 127.0.0.1 HTTP·WebSocket(`ws`, 기본 포트 7790) + 브라우저 뷰어(Vite, `@rhwp/core` 0.8.7 고정 직접 사용) — 결정과 측정값: `docs/decisions/001-stack-and-rhwp.md`, 편집·저장 방식: `docs/decisions/002-edit-and-save.md`, 새 문서 만들기: `docs/decisions/003-create-document.md`
- `any`·타입 단언(`as`) 금지(`as const` 는 허용). rhwp 가 돌려주는 JSON 문자열은 zod 스키마로 읽는다(`src/core/json.ts` parseJson). 오류 문구 꺼내기는 `src/shared/errors.ts` errorMessage
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
npm test               # Vitest: 블록 추출·블록 id·글자 단위·하이라이트 계산·요청/응답·open_document·읽기·하이라이트 도구(가짜/rhwp 테스트 뷰어)·편집 기술 검증·편집 공용 경로·replace_text·insert_paragraph·delete_blocks·move_blocks·undo·insert_table·저장(경로 규칙·검증·새로고침)·스타일(styles.ts·list_styles·set_style·insert_paragraph style)·새 문서 만들기 기술 검증(빈 문서·표·양식 비우기)·
                       # fixture 별 get_outline 기대 JSON(tests/outline/, rhwp 회귀 — 바꿀 때 -u)·서버 통합 (CI)
npm run e2e            # 빌드 후 Playwright: 렌더링·하이라이트·측정·문서 열기·토큰 거부·읽기 도구·하이라이트 도구·편집 표시(표 넣기 포함)·스타일 바꾸기 표시·저장과 새로고침 확인 창 (로컬 전용, CI 에 없음)
node scripts/make-fixtures.ts   # fixtures/ 의 생성 문서 다시 만들기
node scripts/measure-edits.ts [문서…]   # 편집·되돌리기·HWPX 저장 검증 비용 측정 (ADR 002)
node scripts/make-hwp-check.ts [폴더]   # 한글 프로그램 확인용 편집 HWPX (기본 ~/Downloads/docbridge-hwp-check, 레포에 넣지 않음)
node scripts/make-create-check.ts [폴더] # 한글 프로그램 확인용 새로 만든 HWPX (기본 ~/Downloads/docbridge-create-check, ADR 003)
```

- 처음 E2E 를 돌릴 때 `npx playwright install chromium`
- E2E 개발 서버 포트(기본 7792)는 `DOCBRIDGE_E2E_PORT` 로 바꾼다(워크트리 여러 개를 동시에 돌릴 때, 숫자가 아니면 오류). 서버 쪽 E2E 는 빈 포트(0)를 쓴다
- 측정 결과는 `e2e-results/metrics.json`, 스크린샷은 `test-results/screens/` (둘 다 git 에 넣지 않음)

## 폴더 구조

```
src/
  server/      MCP 서버 진입점(index.ts), 도구 등록(mcp.ts), 문서 세션(session.ts: 마지막 파일·id 표·편집 기록·뷰어 요청과 편집 공용 경로),
               읽기 도구(read-tools.ts: 뷰어 요청 + id 붙이기, reading.ts: 개요·읽기 결과와 500블록·20,000자 자르기),
               하이라이트 도구(highlight-tools.ts: 대상 id → id 표 위치로 바꿔 뷰어에 요청),
               편집 도구(edit-tools.ts: replace_text·insert_paragraph·insert_table·delete_blocks·move_blocks·undo → session.edit/undo 편집 공용 경로), 스타일 도구(style-tools.ts: list_styles·set_style, 스타일 목록 항목 styleItems), 옮기기 계획(move-plan.ts: id 표로 이어짐·기준 등 거부 판정과 옮길 문단 범위), 편집 기록(edit-log.ts: 되돌리기 20칸 id 표 사본·저장하지 않은 편집 수),
               저장(save-tool.ts: 뷰어 export_hwpx → 검증 실패면 블록 id → 쓰기 → 마지막 파일·기준 id 표,
               save-path.ts: 경로 규칙·배타적 만들기·임시 파일 → 이름 바꾸기),
               HTTP·WebSocket(bridge.ts: 토큰·포트·요청 전달), 포트 설정(port.ts), 브라우저 열기(browser.ts), stderr 로그
  shared/      서버 ↔ 뷰어 요청/응답 프로토콜(protocol.ts: 메서드별 입력·결과 스키마·요청 id·타임아웃·TextTarget), 오류 문구(errors.ts),
               파일 크기 상한(limits.ts: 열기·저장 50MB), base64(base64.ts: 뷰어·테스트 뷰어 공용)
  core/        rhwp 어댑터 — 블록 모양 zod 스키마(block-schema.ts), 블록 추출(blocks.ts), 블록 id 대응표(block-ids.ts),
               글자 위치 단위(chars.ts: 유니코드 글자 = rhwp 글자 위치), 글자 찾기(find-text.ts),
               하이라이트 사각형(highlight-rects.ts: 줄 끝 보정), 하이라이트 대상 → 사각형(highlight-targets.ts: 요청당 한 번 도는 highlightTargets, 뷰어·테스트 뷰어 공용),
               편집 어댑터(edits.ts: 옮기기·첫 글자 모양 바꾸기·칸·누름틀·문단 넣기), 되돌리기(edit-history.ts: 스냅샷 20칸 + id 표 사본, 칸은 bounded-stack.ts — 서버 edit-log.ts 와 공용),
               편집 종류와 적용(edit-operations.ts: kind 판별 유니언 — 새 편집은 스키마 + applyEdit case 하나), 지우기(delete-blocks.ts: 문단째·표만·거부 판정),
               문단 위치를 바꾼 편집이 실제로 한 일(paragraph-changes.ts: 넣기(part = 새 id 를 받을 블록 — 'text' 문단 글자, 'table:N' 표)·지우기·옮기기(moved), 뷰어 → 서버 id 표 옮기기, relocate = 편집 전 → 뒤 문단 위치),
               편집 공용 경로(document-editor.ts: 스냅샷 → 편집 → 블록 다시 뽑기 → 바뀐 블록, 실패하면 되돌림 — 뷰어·테스트 뷰어 공용),
               HWPX 저장 검증(hwpx-export.ts: 내보내 다시 열어 블록 비교·손실 보고, exportForSave = 뷰어 export_hwpx 결과) — ADR 002,
               본문 문단 위치(body-paragraphs.ts: getControls 등의 문서 전체 문단 번호 → 구역·문단, bodyControlsAt = 문단마다 본문 컨트롤),
               누름틀 목록(fields.ts: getFieldList 스키마·표 칸 경로 판정 fieldTableIndex — 블록 추출·편집·지우기 공용),
               문단 스타일(styles.ts: 스타일 목록·이름으로 찾기·스타일 적용 applyParagraphStyle·스타일 모양 그대로 resetToStyle·제목 스타일·set_style 대상 거부) — ADR 003,
               새 문서 만들기(create-document.ts: 표 넣기(insert_table 편집이 씀, #38)·양식 본문 비우기, #35 기술 검증) — ADR 003,
               Node 용 초기화(rhwp-node.ts)
  viewer/      브라우저 뷰어(Vite root). Canvas 렌더링 + 하이라이트·note·바뀐 블록 표시 오버레이. 디자인 토큰은 tokens.css (의도는 docs/design.md)
tests/         Vitest (Node 에서 rhwp WASM 을 직접 띄움). outline/ = fixture 별 get_outline 기대 JSON
e2e/           Playwright (렌더링·하이라이트·측정·서버가 내주는 뷰어·문서 열기·읽기 도구·하이라이트 도구·편집 표시·스타일 바꾸기 표시)
fixtures/      테스트용 문서와 출처(README.md)
scripts/       fixtures 생성, 편집 비용 측정(measure-edits.ts), 한글 확인 파일 생성(make-hwp-check.ts 편집, make-create-check.ts 새 문서)
docs/          PRD, 스펙, ADR(decisions/), 조사 자료(research/), QA 체크리스트
```
