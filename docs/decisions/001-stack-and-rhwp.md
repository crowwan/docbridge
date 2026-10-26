---
id: 001
status: accepted       # proposed | accepted | superseded
date: 2026-10-26
---

# 001. 스택과 rhwp 사용 방식

## 상황

docbridge 는 Claude 채팅(MCP stdio) ↔ 로컬 서버 ↔ 브라우저 뷰어로 한글 문서를 띄우고, 블록 단위로 읽고, 근거를 하이라이트한다(SPEC-001). 기능 이슈(#5~#8)에 들어가기 전에 다음이 실제로 되는지 확인해야 했다(#4).

- `@rhwp/core` 를 Vite 페이지에서 불러와 공문·보고서를 렌더링하는 속도
- 공개 API 만으로 문단·표·누름틀 블록과 자동 번호 문자열을 뽑을 수 있는지
- `getSelectionRects` 좌표로 그린 오버레이가 글자 위에 정확히 겹치는지
- 블록 id 를 어떻게 붙일지
- MCP stdio 서버와 HTTP·WebSocket 서버가 한 프로세스에서 같이 도는지

근거 자료: `docs/research/rhwp-code-analysis.md`, `docs/research/rhwp-issues-analysis.md`.

## 결정

**GO.** TypeScript 단일 패키지로, Node MCP 서버(stdio) 프로세스가 127.0.0.1 HTTP·WebSocket 서버를 같이 띄우고 Vite 로 빌드한 뷰어를 직접 내준다. 뷰어는 `@rhwp/core` **0.8.7 을 정확한 버전으로 고정**해 직접 쓰고, rhwp 는 포크하지도 기여하지도 않는다. 블록 추출·하이라이트 계산은 뷰어(브라우저)에서 하고, 블록 id 대응표는 서버가 기억한다.

### 스택

| 영역 | 선택 | 버전(고정) |
|---|---|---|
| 런타임 | Node | 24 (`.nvmrc`) |
| 언어 | TypeScript | 7.0.2 (`any`·타입 단언 금지, `.ts` 확장자 import + `rewriteRelativeImportExtensions`) |
| MCP | `@modelcontextprotocol/sdk` (stdio) | 1.32.2 |
| WebSocket | `ws` | 8.22.0 |
| 검증 스키마 | `zod` (rhwp JSON 결과·MCP 입력 파싱) | 4.6.7 |
| 한글 엔진 | `@rhwp/core` (WASM) | 0.8.7 |
| 뷰어 빌드 | Vite | 8.3.5 |
| 테스트 | Vitest(Node 에서 rhwp WASM 을 직접 띄움), Playwright(Chromium) | 5.0.5, 1.64.1 |

포트: 서버 7790(설정 `DOCBRIDGE_PORT`), 뷰어 개발 서버 7791, E2E 개발 서버 7792. 3000 은 쓰지 않는다.

### rhwp 사용 방식

- `@rhwp/core` 를 직접 쓴다. `@rhwp/editor`(iframe) 는 임의 범위 하이라이트·문단 이동 RPC 가 없어서(조사 문서 3장) 쓰지 않는다. PRD 의 열린 질문 "에디터를 붙일지, core 위 최소 뷰어" 는 **core 위 최소 뷰어**로 닫는다.
- 버전은 `package.json` 에 `0.8.7` 로 고정한다(`^` 없음). 0.8.2→0.8.7 처럼 버전마다 추출 결과가 바뀐 사례가 있어서(이슈 분석 문서), 올릴 때는 이 레포의 단위 테스트(fixture 별 `get_outline` 기대 JSON `tests/outline/` 포함, #6)와 E2E 를 회귀 세트로 다시 돌린다.
- rhwp 의 동작이 우리 기대와 다르면 docbridge 쪽 어댑터(`src/core/`)에서 보정하고, 포크·패치하지 않는다. 아래 하이라이트 보정이 그 첫 사례다.
- 렌더링은 `renderPageToCanvas(page, canvas, devicePixelRatio)`. WASM 초기화 전에 `globalThis.measureTextWidth` 를 Canvas `measureText` 로 등록해야 한다(rhwp README 필수 설정).
- Node(테스트·스크립트)에서는 `initSync` 로 같은 WASM 을 띄우고 글자 폭을 근사한다. 그래서 Node 의 쪽 나눔은 브라우저와 다르다(`report.hwpx`: Node 5쪽, Chromium 2쪽). 쪽 번호는 뷰어 값을 기준으로 한다.

## 검증 결과

### 측정 (렌더링 시간)

`npm run e2e` 의 `e2e/measure.spec.ts`. Apple M3 Pro, macOS 26.6, Playwright Chromium(headless), 배율 1. 문서마다 새 브라우저 컨텍스트로 5번 열어 중앙값(ms). WASM 파일은 11.8MB(gzip 4.5MB), 로컬 개발 서버에서 받는다.

| 문서 | 쪽 | WASM 로딩 | 파싱 | 쪽당 렌더링 중앙값 | 쪽당 최대 | 전체 쪽 렌더링 |
|---|---|---|---|---|---|---|
| notice.hwpx | 1 | 29.6 | 47.9 | 33.3 | 41.8 | 33.3 |
| notice.hwp | 1 | 25.0 | 42.8 | 34.3 | 36.7 | 34.3 |
| report.hwpx | 2 | 24.1 | 49.0 | 44.9 | 49.0 | 51.9 |
| application.hwpx | 1 | 25.0 | 44.6 | 30.4 | 36.8 | 30.4 |
| outline-demo.hwpx | 3 | 27.5 | 49.1 | 10.3 | 31.6 | 43.8 |
| (로컬) 실제 공문 2쪽 | 2 | 28.5 | 48.5 | 47.0 | 65.6 | 55.2 |
| (로컬) 법령 개정 설명 9쪽 | 9 | 25.2 | 65.1 | 5.9 | 60.5 | 115.2 |
| (로컬) 통계 보도자료 9쪽 | 9 | 23.8 | 86.0 | 11.2 | 61.5 | 171.0 |
| (로컬) 제안요청서 27쪽 | 27 | 25.0 | 101.8 | 10.4 | 64.0 | 498.5 |
| (로컬) 사업계획서 74쪽 | 74 | 24.6 | 161.9 | 5.1 | 91.3 | 731.1 |

- 새 브라우저를 띄워 처음 열 때 WASM 로딩: 23.5 / 25.4 / 28.7 / 26.6 / 28.9ms.
- 첫 쪽이 가장 느리다(글꼴 준비). 둘째 쪽부터는 쪽당 5~11ms.
- "(로컬)" 행은 rhwp 레포의 실제 한컴 작성 문서(`samples/hwpx/field-multipara-clickhere.hwpx`, `fuzz/corpus/parse_hwpx/issue3307_outline_number.hwpx`, `samples/hwpx/hwpx-01.hwpx`, `samples/hwpx/k-water-rfp.hwpx`, `samples/hwpx/aift.hwpx`, 커밋 `def947c`)로 로컬에서만 잰 값이다. 원 저작권이 적혀 있지 않고 실명·연락처가 든 것도 있어 레포에는 넣지 않았다. 다시 재기: `DOCBRIDGE_EXTRA_FIXTURES_DIR=<폴더> DOCBRIDGE_MEASURE_EXTRA=a.hwpx,b.hwpx npx playwright test measure`
- 판단: 74쪽 문서도 모든 쪽을 한 번에 그리는 데 1초가 안 걸린다. v0.1 은 지연 렌더링 없이 전체 쪽을 그린다.

### 렌더링

- fixtures 5개 모두 모든 쪽이 그려진다(쪽마다 캔버스에 글자 잉크가 있는지 E2E 로 확인). `.hwp` 바이너리도 같다.
- 로컬 실제 문서 5개(`.hwpx`)와 rhwp `samples/basic` 의 실제 `.hwp` 3개(`request.hwp`, `interview.hwp`, `KTX.hwp`)도 열리고 블록이 추출된다.
- 글꼴: 한컴 글꼴이 없으면 브라우저 기본 글꼴로 그린다. 줄바꿈 위치는 그 글꼴 폭 기준이라 한글 프로그램과 다를 수 있다(PRD 열린 질문 그대로).
- 관찰: 오른쪽 정렬 문단 끝의 빈 누름틀 안내문(빨간 기울임)이 오른쪽 여백을 넘어 그려진다(`application.hwpx` "신청인"). 렌더링 표시 문제라 v0.1 범위에서는 그대로 둔다.

### 블록 추출 (`src/core/blocks.ts`)

| 대상 | 방법 | 결과 |
|---|---|---|
| 본문 문단 | `getSectionCount`·`getParagraphCount`·`getTextRange` | 된다. 글자가 없는 빈 문단은 블록으로 내보내지 않는다 |
| 쪽 | `getPageOfPosition` | 된다(뷰어 조판 기준) |
| 표 | `getControls`(ctrlId `tbl`, list 0) → `getTableDimensions`·`getCellInfo`·`getTextInCell` | 된다. 칸마다 행·열·텍스트·같은 행 첫 칸. `getControls` 의 `para` 는 구역을 이어 붙인 문서 전체 번호이고, list 가 0 이 아니면 칸 안(표 안 표)이다 |
| 누름틀 | `getFieldList`(fieldType `clickhere`) | 된다. 이름·안내문·값·표 안 여부 |
| 개요 번호 | `getOutlineNavigation` | 된다. 단 **개요(Outline) 문단만** 준다 |
| 문단 번호(Number) | `getPageTextLayout` 에서 문단 첫 줄 첫 run(`charStart` 0) 바로 앞에 그려진 번호 글자. 처음 찾은 값만 쓴다(다음 쪽 머리말·쪽 번호를 번호로 읽지 않게). 글자 배치는 번호 문단이 시작하는 쪽만 읽고, 못 찾으면 다음 쪽도 본다(#6) | 된다. 번호 문자열은 문서에 저장되지 않고 렌더링 때 계산되므로, 화면에 그려진 값을 읽는다. 개요 번호도 같은 방법으로 읽고 `getOutlineNavigation` 과 같은지 테스트로 맞춰 본다 |
| 직접 타이핑한 번호("1.") | — | 본문 텍스트에 그대로 들어간다. 번호 필드는 비어 있다. 실제 공문(기안문)은 대부분 이쪽이다 |

- `getStructure` 는 개요/조문 트리를 주지만 문단 번호 문자열은 없어서 쓰지 않았다.
- `getSectionStarts` 는 구역 정의(SectionDef) 표식이 든 문단까지 구역 시작으로 센다(rhwp `hwpctrl_sets.rs` `section_starts_json`). 구역 하나에 `[0,1]` 이 나올 수 있어, 표 위치(`getControls` 의 `para`)를 구역·문단으로 나눌 때는 `getParagraphCount` 합을 쓴다(#6, 테스트).
- 실제 기안문 서식은 머리(기관명·수신·제목)와 꼬리(발신명의·결재란·연락처)가 **표 안 누름틀**이다. 누름틀 블록이 이 정보를 준다. 결재란 칸은 표 안 표라 바깥 표 블록의 칸 텍스트에는 나오지 않는다(v0.1 범위 밖, 스펙 기술 메모).

### 하이라이트 (`src/core/highlight-rects.ts`)

- `getSelectionRects` 의 y·높이·오른쪽 끝은 글자와 맞는다.
- **문제**: 범위가 줄 첫 글자에서 시작하면 그 줄 사각형의 왼쪽이 글자 시작이 아니라 단(column) 왼쪽 끝으로 나온다. 가운데 정렬 제목은 앞의 빈 곳까지, 번호 문단은 번호(`2.`)까지, 내어쓴 둘째 줄은 들여쓴 빈 곳까지 칠해진다. 줄 중간에서 시작하는 범위는 문제없다.
- **보정**: 범위가 지나는 줄마다 `getLineInfo`(칸 안이면 `getLineInfoInCell`)로 줄 시작을 구하고, 범위가 줄 첫 글자에서 시작하면 `getCursorRectOnLine(…, lineIndex, at_end=false)` 의 x 로 왼쪽을 바로잡는다. 줄 경계 글자 위치를 `getCursorRect` 로 물으면 앞 줄 끝으로 읽히므로 줄 번호로 묻는다. 줄 수가 rhwp 사각형 수와 다르면 보정하지 않는다.
- **확인**: Playwright 로 ① 오버레이 요소 위치 = 사각형 + 쪽 위치(0.5px 이내) ② 캔버스의 글자 잉크가 사각형 안에 있고 양 끝이 첫·끝 글자에 붙어 있는지(2~4px 이내)를 본다. 한 줄 제목, 두 줄 번호 문단, 문단 일부(날짜), 표 칸, 마지막 쪽 대상(스크롤)이 모두 통과한다. 보정을 빼면 앞의 두 경우가 실패한다. 스크린샷 육안 확인은 PR #10 확인 기록.
- 표 칸은 `getSelectionRectsInCell` 로 같은 방법이 된다.

### 블록 id

`src/core/block-ids.ts` + `tests/block-ids.test.ts` 실험.

- 문서를 열 때 블록마다 문서 순서대로 `b1`, `b2` … 를 붙이고, id → (구역, 문단, 꼬리표) 대응표를 둔다. 꼬리표는 문단 자신 `text`, 표 `table:<컨트롤 번호>`, 누름틀 `field:<문단 안 순서>`.
- docbridge 가 문단을 넣으면(`insertParagraph`) 그 자리부터 뒤 문단 위치를 +1, 지우면(`deleteParagraph`) 그 문단 id 를 없애고 뒤를 -1 한다. 이렇게 하면 넣고 지운 뒤에도 모든 기존 id 가 같은 내용을 가리킨다(테스트). 고치지 않으면 id 가 다른 문단을 가리킨다(테스트).
- 자동 번호는 렌더링 때 다시 계산되므로, `1.` 문단을 지우면 다음 번호 문단이 `1.` 이 된다. id 는 그대로다.
- 문서 안에 id 를 심는 방법(책갈피·숨은 누름틀)은 쓰지 않는다. 저장 파일이 바뀌고, 책갈피가 든 문단은 `importParagraphBlock` 이 거부해 SPEC-002 문단 이동을 막는다(조사 문서 2-1).
- 한계: 사용자가 뷰어에서 직접 고친 내용은 대응표가 따라가지 못한다(v0.1 은 보기 전용이라 해당 없음). 누름틀 꼬리표는 같은 문단 안 순서라 누름틀을 넣고 지우는 편집(SPEC-002)에서는 다시 정해야 한다.

### MCP + HTTP·WebSocket 동시 구동

- `tests/server.test.ts`: MCP SDK `StdioClientTransport` 로 `node src/server/index.ts` 를 실제 하위 프로세스로 띄워 도구를 부르면(검증 때는 `ping`, #5 부터 `open_document`), 같은 프로세스의 WebSocket 에 토큰으로 붙은 클라이언트가 요청을 받는다. 토큰이 없거나 틀리면 401 로 거부한다. 뷰어 페이지와 `.wasm`(`application/wasm`) 을 127.0.0.1 에서 내준다.
- `e2e/served-viewer.spec.ts`: 서버가 내준 빌드된 뷰어 페이지에서 rhwp WASM 이 뜬다.
- stdout 은 MCP 전용이고 로그는 stderr 로만 쓴다(`src/server/log.ts`). 뷰어 연결 하나의 오류(잘못된 WebSocket 프레임, 연결 끊김)는 그 연결만 정리하고 로그를 남긴다. 처리하지 않으면 처리 안 된 'error' 이벤트로 MCP 서버 프로세스 전체가 죽는다(PR #10 리뷰, 재현 테스트 `tests/server.test.ts`). 빌드 결과(`node dist/server/index.js`)에 initialize 요청을 보내 정상 응답을 받는 것도 손으로 확인했다.
- Claude Desktop 에 실제 등록해 보는 것은 #8 에서 한다.

## 열린 질문 결론 (SPEC-001 에 반영)

| 질문 | 결론 | 근거 |
|---|---|---|
| 블록 id 를 붙이는 방식 | 위치 인덱스 대응표. 서버가 id 표를 기억하고, docbridge 편집 명령마다 위치를 옮긴다 | 위 "블록 id" 실험. 문서 안에 심는 방법은 저장 파일 변경·문단 이동 거부 문제 |
| 브라우저를 자동으로 띄울지 | 연결된 뷰어가 없을 때만 기본 브라우저로 띄우고, 결과에 뷰어 주소도 함께 준다. 이미 연결된 뷰어가 있으면 새 탭을 열지 않고 그 탭의 문서를 바꾼다 | 문서 상태의 기준이 뷰어라 뷰어 없이는 어떤 도구도 못 쓴다. 문서는 한 번에 하나라 탭을 늘릴 이유가 없다. 띄우기가 실패해도 주소로 열 수 있다 |
| `.hwp` 열기를 v0.1 에 넣을지 | 넣는다(열기·읽기·하이라이트). 저장은 PRD 대로 HWPX 만 | `notice.hwp` 가 `.hwpx` 와 같은 블록을 내고 같게 렌더링된다(테스트). 실제 한컴 `.hwp` 3개도 로컬에서 열린다. 같은 `HwpDocument` 생성자라 추가 비용이 없다 |

## 검토한 대안

| 대안 | 장점 | 단점 |
|---|---|---|
| `@rhwp/core` 직접 사용 (선택) | 하이라이트·블록 추출·편집 API 를 다 쓸 수 있다. 문서가 브라우저 메모리 한 벌 | 뷰어 UI(쪽 표시, 스크롤)를 직접 만든다 |
| `@rhwp/editor` iframe | 메뉴·툴바·IME 편집을 공짜로 얻는다 | 임의 범위 하이라이트·문단 이동 공개 RPC 가 없다 |
| rhwp MCP(`rhwp mcp-serve`) 확장·포크 | 읽기 도구가 이미 많다 | 파일 기반이라 뷰어와 연결 경로가 없고, 문서가 Rust 서버와 브라우저에 두 벌 생긴다. 포크 유지비 |
| `getSelectionRects` 를 그대로 쓰기 | 코드가 없다 | 줄 첫 글자부터 고른 범위가 글자 밖까지 칠해진다(위 하이라이트) |
| 블록 id 를 내용 해시로 | 대응표가 필요 없다 | 같은 문구의 문단·빈 칸이 겹치고, 문단을 고치면 id 가 바뀐다 |
| SVG 렌더링(`renderPageSvg`) | 확대해도 선명, 글자 선택 가능 | 이번 검증은 Canvas 로 했다. 필요해지면 다시 본다 |

## 결과

- 쉬워지는 것: #5~#7 은 이 골격(`src/server`, `src/viewer`, `src/core`)에 도구와 메시지를 더하면 된다. rhwp 결과 JSON 은 zod 스키마로 읽어 타입 단언 없이 다룬다.
- 어려워지는 것: rhwp 버전을 올릴 때마다 하이라이트 보정과 번호 읽기(글자 배치 기반)가 그대로 맞는지 E2E 로 다시 봐야 한다.
- 다시 볼 조건: rhwp 가 `getSelectionRects` 줄 시작 동작을 바꾸거나 문단 번호 문자열 API 를 내면 보정·추출을 걷어낸다. 표 안 표·각주 등 v0.1 범위 밖 문서를 다루게 되면 블록 정의를 다시 본다. Claude Desktop 실제 등록(#8)에서 stdio·포트 문제가 나오면 이 ADR 을 고친다.
