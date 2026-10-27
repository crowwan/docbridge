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

- 마일스톤: v0.2 (v0.1.0 릴리스 2026-10-27)
- 진행 중 스펙: SPEC-001·002 done(v0.1.0), SPEC-003 새 문서 만들기 (in-progress, #34), SPEC-004 설치와 배포 (draft), SPEC-005 여러 자리 한 번에 바꾸기 (in-progress, #54), SPEC-006 뷰어에서 직접 고치기 (in-progress, #57), SPEC-007 여러 문서와 문서 사이 복사 (in-progress, #61, v0.3)
- Projects 보드: #6 (https://github.com/users/crowwan/projects/6)

## 스택

- Web (TS, Node 24). 로컬 MCP 서버(stdio, `@modelcontextprotocol/sdk`) + 같은 프로세스의 127.0.0.1 HTTP·WebSocket(`ws`, 기본 포트 7790) + 브라우저 뷰어(Vite, `@rhwp/core` 0.8.7 고정 직접 사용) — 결정과 측정값: `docs/decisions/001-stack-and-rhwp.md`, 편집·저장 방식: `docs/decisions/002-edit-and-save.md`, 새 문서 만들기: `docs/decisions/003-create-document.md`, 문서 사이 복사: `docs/decisions/004-cross-document-copy.md`
- `any`·타입 단언(`as`) 금지(`as const` 는 허용). rhwp 가 돌려주는 JSON 문자열은 zod 스키마로 읽는다(`src/core/json.ts` parseJson). 오류 문구 꺼내기는 `src/shared/errors.ts` errorMessage
- 상대 import 는 `.ts` 확장자까지 쓴다(Node 가 TS 를 바로 실행하고, 빌드 때 `.js` 로 바뀐다)
- stdout 은 MCP 전용. 서버 로그는 `src/server/log.ts`(stderr)로만 쓴다
- 포트 3000 금지: 서버 7790, 뷰어 개발 서버 7791, E2E 개발 서버 7792, 데모 녹화 서버 7900
- 조사 자료: `docs/research/`

## 실행

```bash
npm ci                 # 의존성 설치 (Node 24)
npm run dev            # 뷰어 개발 서버 http://127.0.0.1:7791/?fixture=notice.hwpx
npm run build          # 서버(tsc → dist/server) + 뷰어(vite → dist/viewer)
npm start              # 빌드 결과 실행: MCP 서버(stdio) + 뷰어 서버(7790, 사용 중이면 7799 까지 다음 포트).
                       # = node dist/server/index.js. DOCBRIDGE_PORT 로 시작 포트 변경
npm run typecheck
npm test               # Vitest: 블록 추출·블록 id·글자 단위·하이라이트 계산·note 자리·요청/응답·open_document·읽기·하이라이트 도구(가짜/rhwp 테스트 뷰어)·편집 기술 검증·편집 공용 경로·replace_text·replace_all·insert_paragraph·delete_blocks·move_blocks·undo·insert_table·저장(경로 규칙·검증·새로고침)·스타일(styles.ts·list_styles·set_style·insert_paragraph style)·새 문서 만들기(create_document·새 문서 저장·새로고침)·새 문서 만들기 기술 검증(빈 문서·표·양식 비우기)·문서 사이 복사 기술 검증(importParagraphBlock·번호·스타일 보정·HTML 대안)·사람 편집 요청(user_edit·⌘Z 공용 되돌리기·알림·늦은 요청 거부)·더블클릭 고칠 자리(hitTest → 블록·칸·누름틀, 바뀐 범위만, 누름틀 걸침, 입력 중 Claude 편집 따라가기)·끌어 옮기기·메뉴(점 → 본문 블록, 놓일 자리, 지우기·위로·아래로)·여러 문서(doc 표·마지막으로 쓴 문서·문서별 id/undo/편집 수·8개 상한·close_document·탭 닫기 알림·문서별 사람 편집·같은 파일 = 실제 경로·다른 문서 파일로 저장 거부)·copy_blocks(원본 범위 계획·대상 탭 편집·보정 후속·문서 사이/같은 문서 복사·거부)·
                       # fixture 별 get_outline 기대 JSON(tests/outline/, rhwp 회귀 — 바꿀 때 -u)·서버 통합 (CI)
npm run e2e            # 빌드 후 Playwright: 렌더링·하이라이트·측정·문서 열기·토큰 거부·읽기 도구·하이라이트 도구·편집 표시(표 넣기 포함)·스타일 바꾸기 표시·저장과 새로고침 확인 창·새 문서 만들기(빈 문서·양식·확인 창)·사람 편집 요청과 ⌘Z·더블클릭 글자 고치기·여러 문서 탭(탭 제목·doc 이름·●·탭 닫기 알림·close_document·copy_blocks 대상 탭 표시와 undo)·끌어 옮기기와 오른쪽 클릭 메뉴 (로컬 전용, CI 에 없음)
node scripts/make-fixtures.ts   # fixtures/ 의 생성 문서 다시 만들기
node scripts/measure-edits.ts [문서…]   # 편집·되돌리기·HWPX 저장 검증 비용 측정 (ADR 002)
node scripts/make-hwp-check.ts [폴더]   # 한글 프로그램 확인용 편집 HWPX (기본 ~/Downloads/docbridge-hwp-check, 레포에 넣지 않음)
node scripts/make-create-check.ts [폴더] # 한글 프로그램 확인용 새로 만든 HWPX (기본 ~/Downloads/docbridge-create-check, ADR 003)
node scripts/make-copy-check.ts [폴더]   # 한글 프로그램 확인용 다른 문서에서 복사해 넣은 HWPX (기본 ~/Downloads/docbridge-copy-check, ADR 004)
npm run demo           # 빌드 후 데모 영상 녹화(scripts/demo/, 서버 포트 7900, 헤드리스 Chromium) → ~/Downloads/docbridge-demo (레포에 넣지 않음)
```

- 처음 E2E 를 돌릴 때 `npx playwright install chromium`
- Vitest 시간 제한은 60초(멈춘 테스트를 잡는 용도, `vitest.config.ts`). 파일마다 작업자가 동시에 돌아 WASM 큰 작업은 혼자 돌 때보다 몇 배 느리므로, 테스트는 시간·기계 부하에 기대지 않게 쓴다(타이머는 가짜 타이머, 문서는 테스트마다 새로 열기) — #78
- E2E 개발 서버 포트(기본 7792)는 `DOCBRIDGE_E2E_PORT` 로 바꾼다(워크트리 여러 개를 동시에 돌릴 때, 숫자가 아니면 오류). 서버 쪽 E2E 는 빈 포트(0)를 쓴다
- 측정 결과는 `e2e-results/metrics.json`, 스크린샷은 `test-results/screens/` (둘 다 git 에 넣지 않음)

## 폴더 구조

```
src/
  server/      MCP 서버 진입점(index.ts), 도구 등록(mcp.ts: 문서 도구마다 doc(선택) → 대상 문서 세션, 결과 맨 위 doc, list_documents·close_document),
               여러 문서 표(documents.ts: doc(d1, d2 …) → 문서 세션, 같은 파일 다시 열기 = 같은 doc(같은 파일 = 실제 경로, paths.ts realFilePath — 열린 다른 문서의 파일로는 저장하지 않는다), 8개 상한, 마지막으로 쓴 문서, 탭 연결·끊김(새로고침이면 그 문서만 다시 띄움, 5초 안에 다시 붙지 않으면 탭을 닫은 것), 다음 결과 알림 모으기(다른 문서 알림 앞 "d2: ") — SPEC-007),
               문서 세션(session.ts: 문서 하나 = 탭 하나, 문서마다 직렬 큐, 문서 자리(연 파일 / 저장 전 새 문서)·마지막 파일·id 표·편집 기록·뷰어 요청과 편집 공용 경로, create = create_document),
               읽기 도구(read-tools.ts: 뷰어 요청 + id 붙이기, reading.ts: 개요·읽기 결과와 500블록·20,000자 자르기),
               하이라이트 도구(highlight-tools.ts: 대상 id → id 표 위치로 바꿔 뷰어에 요청),
               문서 사이 복사(copy-tool.ts: copy_blocks — 원본 줄에서 범위 계획 + export_hwpx 바이트 → 대상 session.edit 편집 하나, SPEC-007), 편집 도구(edit-tools.ts: replace_text·replace_all(서버가 일치를 구해 replace_text 여러 자리 편집으로)·insert_paragraph·insert_table·delete_blocks·move_blocks·undo → session.edit/undo 편집 공용 경로), 사람 편집(user-edit.ts: 뷰어 user_edit 블록 위치 → id 표로 id, 문서 상태 번호 확인(뷰어가 본 문서 = 줄 차례의 문서), 받은 뒤 20초 넘게 늦은 요청 거부(USER_REQUEST_DEADLINE_MS < 뷰어 기다림), 같은 session.edit 줄·거부 규칙, ⌘Z user_undo — SPEC-006, 그 탭 문서 세션으로 — 알림은 documents takeNotices), 스타일 도구(style-tools.ts: list_styles·set_style, 스타일 목록 항목 styleItems), 옮기기 계획(move-plan.ts: id 표로 이어짐·기준 등 거부 판정과 옮길 문단 범위, copy_blocks 원본 범위 planCopySource 도 같은 범위 규칙), 편집 기록(edit-log.ts: 되돌리기 20칸 id 표 사본·저장하지 않은 편집 수·문서 상태 번호 state — 편집·되돌리기·edit_state 요청에 실어 뷰어에 보낸다),
               저장(save-tool.ts: 뷰어 export_hwpx → 검증 실패면 블록 id → 쓰기 → 마지막 파일·기준 id 표,
               save-path.ts: 경로 규칙(새 문서 경로·새 문서 저장 포함)·배타적 만들기·임시 파일 → 이름 바꾸기),
               HTTP·WebSocket(bridge.ts: 토큰·포트, 연결마다 문서 이름(주소 &doc=, 없으면 빈 탭)·요청 추적, 요청은 그 문서의 마지막 연결로, 빈 탭 쓰기 claimViewer·빈 탭으로 돌리기 releaseViewer, 뷰어 요청 받기 serveUserRequests — 그 문서의 마지막 탭만), 포트 설정(port.ts), 브라우저 열기(browser.ts), stderr 로그
  shared/      서버 ↔ 뷰어 요청/응답 프로토콜(protocol.ts: 메서드별 입력·결과 스키마·요청 id·타임아웃·TextTarget, 뷰어 → 서버 user_request(user_edit·user_undo)/user_response, 사람 편집 서버 마감 USER_REQUEST_DEADLINE_MS·뷰어 타임아웃 문구 userRequestTimeoutMessage), 오류 문구(errors.ts), 거부 코드와 사람용 문구(rejections.ts: EditRejection = Claude 용 message + code, 거부 코드 → 사람용 문구 표 — 사람 편집 거부 알림, 뷰어 응답에도 code 를 실음, #77),
               파일 크기 상한(limits.ts: 열기·저장 50MB), base64(base64.ts: 뷰어·테스트 뷰어 공용)
  core/        rhwp 어댑터 — 블록 모양 zod 스키마(block-schema.ts), 블록 추출(blocks.ts), 블록 id 대응표(block-ids.ts),
               글자 위치 단위(chars.ts: 유니코드 글자 = rhwp 글자 위치, changedRange = 입력 전후의 바뀐 범위만, 입력칸 커서로 같은 글자 이어짐 가르기),
               뷰어에서 고칠 자리(edit-spot.ts: 점 → rhwp hitTest → 본문 블록 blockAtHit·고칠 자리와 테두리 editSpotAt·입력칸 글자 → 사람 편집 replaceEditAt(누름틀 걸침)·입력 중 블록 위치 따라가기 followEdit·입력칸 다시 둘 자리 spotBox·점 → 본문 블록 bodyBlockAt(끌기·메뉴) — SPEC-006), 끌어 옮기기·메뉴 편집(block-moves.ts: 본문 블록 쪽별 사각형 blockBands·놓일 자리와 가로선 dropAt·지우기·위로·아래로 menuEdits — #60), 글자 찾기(find-text.ts: findReplaceable = replace_all 일치, 누름틀 값에 걸친 것 뺌), 누름틀 값 자리(field-spans.ts: 문단·칸 글자 안 누름틀 값 [start, end) 와 걸침 판정 — 서버 replace_all·뷰어 replace_text 공용),
               하이라이트 사각형(highlight-rects.ts: 줄 끝 보정), 하이라이트 대상 → 사각형(highlight-targets.ts: 요청당 한 번 도는 highlightTargets, 뷰어·테스트 뷰어 공용), note 자리(note-placement.ts: 위 → 쪽 바깥 여백 → 아래, 쪽 글자 사각형과 겹침 판정),
               편집 어댑터(edits.ts: 옮기기·첫 글자 모양 바꾸기·칸·누름틀·문단 넣기), 되돌리기(edit-history.ts: 스냅샷 20칸 + id 표 사본, 칸은 bounded-stack.ts — 서버 edit-log.ts 와 공용),
               편집 종류와 적용(edit-operations.ts: kind 판별 유니언 — 새 편집은 스키마 + applyEdit case 하나, copy_blocks 는 원본 HWPX base64 를 실어 copyParagraphs), 지우기(delete-blocks.ts: 문단째·표만·거부 판정),
               문단 위치를 바꾼 편집이 실제로 한 일(paragraph-changes.ts: 넣기(parts = 새 id 를 받을 블록들 — 'text' 문단 글자, 'table:N' 표, 'field:N' 누름틀, copy_blocks 빈 문단은 [])·지우기·옮기기(moved), 뷰어 → 서버 id 표 옮기기, relocate = 편집 전 → 뒤 문단 위치),
               편집 공용 경로(document-editor.ts: 스냅샷 → 편집 → 블록 다시 뽑기 → 넣은 문단 블록이 parts 와 같은지 → 바뀐 블록, 실패하면 되돌림 — 뷰어·테스트 뷰어 공용),
               HWPX 저장 검증(hwpx-export.ts: 내보내 다시 열어 블록 비교·손실 보고, exportForSave = 뷰어 export_hwpx 결과) — ADR 002,
               본문 문단 위치(body-paragraphs.ts: getControls 등의 문서 전체 문단 번호 → 구역·문단, bodyControlsAt = 문단마다 본문 컨트롤),
               누름틀 목록(fields.ts: getFieldList 스키마·표 칸 경로 판정 fieldTableIndex — 블록 추출·편집·지우기 공용),
               문단 스타일(styles.ts: 스타일 목록·이름으로 찾기·스타일 적용 applyParagraphStyle·스타일 모양 그대로 resetToStyle·제목 스타일·set_style 대상 거부) — ADR 003,
               새 문서 만들기(create-document.ts: 표 넣기(insert_table 편집이 씀, #38)·양식 본문 비우기, #35 기술 검증, createNewDocument = 뷰어가 새 문서 만들기(#36)) — ADR 003,
               문서 사이 복사(copy-paragraphs.ts: 원본 HWPX 바이트 → importParagraphBlock + 번호(넣는 자리 앞 목록 우선)·스타일(다음 스타일 포함, 넣은 문단만 봄) 보정 — copy_blocks 편집이 씀) — ADR 004,
               Node 용 초기화(rhwp-node.ts)
  viewer/      브라우저 뷰어(Vite root). Canvas 렌더링 + 하이라이트·note·바뀐 블록 표시 오버레이. 탭 하나 = 문서 하나(주소 &doc=, 도구 막대 doc 이름, 탭 제목 = 파일 이름·보지 않는 사이 바뀌면 ●, close_document 면 빈 탭).) 사람 편집은 서버에 user_edit 로 보내고(window.docbridge.userEdit), ⌘Z/Ctrl+Z 는 서버 user_undo.
               더블클릭 글자 고치기(inline-edit.ts: 마우스 올림 테두리·입력칸), 끌어 옮기기·오른쪽 클릭 메뉴(block-actions.ts: 놓일 자리 가로선·role=menu 위로·아래로·지우기·메뉴 키), 실패 알림(toast.ts: 뷰어 아래 3초). 디자인 토큰은 tokens.css (의도는 docs/design.md)
tests/         Vitest (Node 에서 rhwp WASM 을 직접 띄움). outline/ = fixture 별 get_outline 기대 JSON
e2e/           Playwright (렌더링·하이라이트·측정·서버가 내주는 뷰어·문서 열기·읽기 도구·하이라이트 도구·편집 표시·스타일 바꾸기 표시·사람 편집과 ⌘Z·더블클릭 글자 고치기·여러 문서 탭·끌어 옮기기와 메뉴)
fixtures/      테스트용 문서와 출처(README.md)
scripts/       fixtures 생성, 편집 비용 측정(measure-edits.ts), 한글 확인 파일 생성(make-hwp-check.ts 편집, make-create-check.ts 새 문서, make-copy-check.ts 문서 사이 복사), 데모 영상 녹화(demo/: 채팅+뷰어 화면 demo.html, record-demo.ts)
docs/          PRD, 스펙, ADR(decisions/), 조사 자료(research/), QA 체크리스트
```
