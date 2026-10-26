# rhwp 코드 분석: Claude ↔ MCP ↔ 브라우저 뷰어 실시간 구상 관점

- 분석 대상: `edwardkim/rhwp` **devel** `def947c` (2026-10-23 13:03 KST). main 은 `1a76570` = 태그 v0.8.7 (2026-10-06).
  MCP/embed/editor 관련 main↔devel 차이는 13파일 +439/-34줄(주로 `field-focus-events-v1`, `getPageSvg` 프로필 추가)이라 결론에 영향 없음.
- 소스 위치: `/private/tmp/claude-501/-Users-kimjin-wan-Works-personal/6612b130-8021-4a39-aae2-51c6580ab46c/scratchpad/rhwp-src2/repo` (partial + sparse clone, 실행·빌드 안 함)
- npm 패키지: `/private/tmp/claude-501/-Users-kimjin-wan-Works-personal/6612b130-8021-4a39-aae2-51c6580ab46c/scratchpad/rhwp-npm/` (`@rhwp/core` 0.8.7, `@rhwp/editor` 0.8.7, 압축만 해제)
- 아래 경로는 레포 루트 기준 상대 경로. `core d.ts` = `rhwp-npm/rhwp-core-0.8.7/package/rhwp.d.ts`, `editor d.ts` = `rhwp-npm/rhwp-editor-0.8.7/package/index.d.ts`.

---

## 핵심 결론 5줄

1. rhwp MCP 는 **이미 있다**(`rhwp mcp-serve`, Rust 단일 바이너리, **stdio 전용**). 도구는 무상태 약 164개 + 세션 18개로 많지만, **전부 파일 경로 기반**이고 브라우저 뷰어와 연결되는 경로는 **0**이다.
2. 세션 편집(`hwp_doc_*`)은 **치환·셀·누름틀 3종뿐**이다. 문단 삽입·삭제·분할·병합은 "파일 읽고 새 파일로 쓰기" 무상태 도구로만 있고, **문단 이동/복사 도구는 MCP·CLI·WASM 어디에도 없다.**
3. 브라우저 쪽 외부 조작 진입점은 `@rhwp/editor` 의 **postMessage+MessageChannel RPC**다. 공개된 편집은 ① 문단 1개 통째 교체(`applyTextCommand`, 제약 강함) ② `createStudio`+`hwpctrl` 플러그인(웹한글컨트롤 API 호환, 커서·선택·삭제·표 편집, 배치=undo 1스텝)이다. **잘라내기/붙여넣기와 범위 하이라이트는 공개 API에 없다.**
4. "문단 이동"은 `@rhwp/core` 를 **직접** 쓰면 `importParagraphBlock`(통째 문단 복제, 서식·리소스 리매핑) + `deleteParagraph` + `saveSnapshot` 조합으로 **가능**하다. 자동 번호(개요/문단 번호)는 렌더 시 문단 순서대로 다시 계산하므로 옮기면 번호가 다시 매겨진다. 단, 각주·책갈피·하이퍼링크·자동번호 컨트롤이 든 문단은 블록 복제가 거부한다.
5. 추천은 **새로 만들기**(로컬 MCP 브리지 + 우리 뷰어가 `@rhwp/core` 직접 사용)다. 엔진은 MIT 그대로 쓰고, 업스트림 MCP 는 포크하지 않는다. 읽기·추출 품질이 필요하면 `rhwp mcp-serve` 를 하위 프로세스로 함께 붙여 둔다. 업스트림에는 `moveParagraphBlock`·범위 하이라이트 RPC 를 이슈/PR 로 제안할 만하다.

---

## 1. rhwp MCP

### 1-1. 위치·런타임·실행 방식·배포

| 항목 | 내용 | 근거 |
|---|---|---|
| 위치 | `src/mcp_serve.rs`(2,596줄) + 도구 선언 `src/cli/metadata/mcp/*.rs`(read/edit_content/edit_format/edit_structure/exchange/advanced/protocol) | `src/mcp_serve.rs:1-17`, `src/cli/metadata/mcp/mod.rs:247` `mcp_tool_definitions()` |
| 언어/런타임 | Rust, `rhwp` 바이너리의 서브커맨드. 외부 MCP SDK 없이 serde_json 으로 직접 구현. WASM 대상에는 포함 안 됨 | `src/mcp_serve.rs:15-16` |
| 전송 | **stdio JSON-RPC 2.0 만**. 네트워크 포트 없음. 프로토콜 `2025-06-18` | `src/mcp_serve.rs:23`, `src/mcp_serve.rs:560`(stdin 줄 루프), `mydocs/manual/mcp_integration_guide.md:33-35` |
| 실행 | `rhwp mcp-serve [--profile <역할>] [--stats] [--workspace <dir>]` | `src/mcp_serve.rs:473-517` |
| 등록 | `.mcp.json`: `{"command":"rhwp","args":["mcp-serve"]}`. Claude Desktop 등 18개 호스트 설정 모음 문서 있음 | `.mcp.json`, `README.md:236-258`, `mydocs/manual/mcp_attach_kit.md:40` |
| 배포 | GitHub Releases 의 **플랫폼 바이너리**(linux x86_64/aarch64, macOS x86_64/aarch64, windows x86_64) + SHA256SUMS. npm 패키지·`.mcpb` 번들은 **없음** | `README.md:183-196`, `.github/workflows/release-binary.yml:29-54,106` |

### 1-2. 도구 목록 (요약)

**실행 구조**: 무상태 도구는 선언의 `cli.args` 템플릿을 채워 **자기 자신을 서브프로세스로 실행**한다(CLI 계약 그대로 재사용). 세션 도구만 프로세스 메모리에 `HwpDocument` 를 들고 있다.
근거: `src/mcp_serve.rs:7-14`, `src/mcp_serve.rs:2457`(`run_cli_tool`), `src/mcp_serve.rs:1372-1432`(디스패치).

**세션 도구 18개** (`src/mcp_serve.rs:1148-1360`, 디스패치 `:1398-1432`)

| 도구 | 입력 | 출력/동작 |
|---|---|---|
| `hwp_open` | `path`, `password?` | `docId`, `pageCount` |
| `hwp_doc_text` | `docId`, `page?`, `maxChars?`, `charOffset?` | 쪽 단위 평문, `nextOffset` 페이지네이션 (`:1213-1224`, 구현 `:1641`) |
| `hwp_doc_info` / `hwp_doc_fields` / `hwp_doc_tables` | `docId` | 메타 / 누름틀 목록 / 표 격자 JSON(병합·중첩 보존) |
| `hwp_doc_search` | `docId`, `query`, … | `matches[].section/paragraph/page/context` (`:1247-1260`) |
| `hwp_doc_structure` | `docId`, `mode`(auto/outline/clause) | 개요·조문 트리 (`:1263-1264`) |
| `hwp_doc_extract_data` | `docId` | 날짜·금액·수량 추출 |
| `hwp_doc_tree` | `docId` | 페이지 `p0..`, 표 `t0..`, 문단/셀 `nodePath`(`sec[i]/para[i]/ctrl[i]/cell[r,c]`) + `textPreview` (`:406-446`) |
| `hwp_doc_render_page` | `docId`, `page`, `output` | SVG **파일로 저장** |
| `hwp_doc_replace_text` / `hwp_doc_set_cell` / `hwp_doc_fill_fields` | `docId` + 값 | 메모리 IR 에 누적, `changedPages` 반환 (`:1288-1319`) |
| `hwp_doc_save` | `docId`, `output`, `verify?` | 파일 저장(HWPX→HWPX, 그 외→HWP5) (`:1330-1340`) |
| `hwp_close`, `hwp_ws_list/open/journal` | | 핸들 닫기, 워크스페이스 인벤토리, 변이 저널(본문 SHA 전/후) |

**무상태 도구 약 164개** (모두 `path` 입력 → `output` 파일 출력, `dryRun` 지원). 문단·구조 관련만 추리면:

| 범주 | 도구 (선언 위치) |
|---|---|
| 읽기 | `hwp_info`, `hwp_export_text`, `hwp_export_markdown`, `hwp_export_structure`, `hwp_export_tables`, `hwp_search`, `hwp_fields`, `hwp_export_svg/png/pdf` (`read.rs`) |
| 문단 | `hwp_insert_paragraph`(`edit_content.rs:168`), `hwp_delete_paragraph`(`edit_structure.rs:33`), `hwp_split_paragraph`(`:674`), `hwp_merge_paragraph`(`:83`), `hwp_insert_text`/`hwp_delete_text` |
| 서식 | `hwp_apply_char_format`, `hwp_apply_para_format`, `hwp_apply_style` (`edit_format.rs`) |
| 번호 | `hwp_set_numbering_restart`(`edit_content.rs:280`), `hwp_insert_number`(`advanced.rs:84`) |
| 표 | `hwp_insert_row/col`, `hwp_delete_row/col`, `hwp_set_cell`, `hwp_merge_cells`, `hwp_split_cell`, `hwp_move_table`(좌표 이동) |
| 계획 실행 | `hwp_run_plan`(`protocol.rs:6`): fill_fields·replace_text·set_cell·set_checkbox 를 원자 실행. `import_paragraph_block`, `repeat_and_fill_paragraph_block` 은 **단독 step** 으로만 |

**문단 이동(move) 도구는 없다.** `grep` 결과 CLI 의 이동은 `move-table`(표 좌표 이동)뿐이다 (`src/cli/commands/edit/mod.rs:112`).

### 1-3. 파일 기반인가, 뷰어 연동인가

- 무상태: 경로를 받아 읽고 **새 파일**을 쓴다(`hwp_insert_paragraph` 기본 출력 `<입력명>_paragraph.hwp`, `edit_content.rs:176`).
- 세션: 메모리 누적 후 `hwp_doc_save` 로만 기록. 서버가 내려가면 핸들 소멸(`mcp_integration_guide.md:96`).
- 브라우저 연동: `src/` 전체에 TcpListener/WebSocket/HTTP 서버 코드 없음. 공식 설계 문서도 "브라우저에는 stdio 가 없다, 무엇에 얹을지 미정"이라고 적고 있다(`mydocs/tech/wasm_agent_surface/README.md`의 M24 절, `browser_bridge.md:195-215`).

### 1-4. LLM 에 주는 형태

- 본문: 쪽 단위 평문(`hwp_doc_text`), 또는 Markdown(`hwp_export_markdown`).
- 위치: `section/paragraph/page` 인덱스(검색), `nodePath`(트리), 표는 `t{i}` + `row/col`.
- **블록 ID 는 위치 인덱스뿐**이다. "같은 문서·같은 빌드에서 결정론"이라고만 보장한다(`mcp_serve.rs:432-441`). 문단을 넣거나 지우면 뒤 번호가 모두 밀린다. 영속 문단 ID 는 없다(`src/model/identity.rs` 는 컨트롤 instance id 예약용).

---

## 2. 구조 편집 API (`@rhwp/core` WASM)

모든 메서드는 `HwpDocument` 인스턴스 메서드이고, 대부분 JSON 문자열을 반환한다. 시그니처는 `core d.ts` 줄 번호를 따른다.

### 2-1. 문단 단위

| 기능 | 메서드 | 근거 | 비고 |
|---|---|---|---|
| 빈 문단 삽입 | `insertParagraph(sec, para)` | d.ts:1571, `src/wasm_api.rs:2699`, 구현 `src/document_core/commands/text_editing.rs:4343` | **앞 문단 서식 상속**(Enter 와 동일). `para_idx==0` 이면 구역 시작 표식을 새 첫 문단으로 옮김(`:4375-4392`) |
| 문단 삭제 | `deleteParagraph(sec, para)` | d.ts:353, `wasm_api.rs:2693`, 구현 `text_editing.rs:4228` | 구역 마지막 문단은 거부. 삭제 후 reflow·vpos·페이지네이션 |
| 분할/병합 | `splitParagraph(sec,para,off)`, `mergeParagraph(sec,para)` | d.ts:2360, 1696 | |
| 범위 삭제 | `deleteRange(sec, sp, so, ep, eo)` | d.ts:365, `wasm_api.rs:6865` | 문단 경계를 넘으면 병합됨 |
| 범위 복사 | `copySelection(sec, sp, so, ep, eo)` → 내부 클립보드 | d.ts:220, `wasm_api.rs:8552`, `clipboard.rs:371` | 같은 구역만 |
| 붙여넣기 | `pasteInternal(sec, para, off)` | d.ts:1851, `wasm_api.rs:8714`, `clipboard.rs:769` | 아래 2-2 위험 참고 |
| HTML 붙여넣기 | `pasteHtml(...)`, `exportSelectionHtml(...)` | d.ts:1822, 568 | |
| **통째 문단 블록 복제** | `importParagraphBlock(sourceDoc, optionsJson)` | d.ts:1476, `src/wasm_api/template_automation.rs:9-17`, 구현 `src/document_core/commands/paragraph_block/import.rs:120-160` | `{request:{sourceSection,sourceStart,sourceEnd,targetSection,insertBefore,count},dryRun}`. **다른 핸들**에서 가져온다. 클립보드·경계 병합 없이 문단을 통째로 넣고 서식·BinData 리소스를 리매핑한다 |
| 같은 문서 블록 반복 | `applyTemplateOperation({operation:{action:"repeat_and_fill_paragraph_block",...}})` | `template_automation.rs:19-25`, `paragraph_block/template_operation.rs:13-22`, `repeat.rs:70-80` | "clipboard or boundary merges 없음"(`repeat.rs:71`). 템플릿 채우기용 계약(`records` 수 = `count`) |
| 문단 이동 | **없음** | `grep moveParagraph` 0건 | |

블록 복제가 거부하는 컨트롤: SectionDef, ColumnDef, 머리말/꼬리말, **각주/미주, AutoNumber, NewNumber, 책갈피, 하이퍼링크**, 덧말, 숨은 설명, 양식 개체, 차트, OLE 등 (`paragraph_block/validation/support.rs:252-278`). 표·그림·일반 텍스트는 된다.
또 원본 구역에 개요 번호 정의가 없는데 대상에 있으면 개요 문단 가져오기를 거부한다(`import.rs:181-201`).

### 2-2. 붙여넣기(paste) 서식 위험 (코드 확인)

`paste_internal_native` 의 다중 문단 경로(`clipboard.rs:856-880`)는 다음 순서로 동작한다.
1. 대상 문단을 캐럿에서 둘로 나눈다(`split_at`, 새 문단은 대상의 `para_shape_id` 상속, `paragraph.rs:1649,1967`).
2. **왼쪽 절반에 클립보드 첫 문단을 `merge_from` 으로 이어 붙인다** → 첫 문단은 **대상 문단의 문단 모양**을 갖게 된다(`merge_from` 은 문단 모양을 바꾸지 않음, `paragraph.rs:2000`).
3. 마지막 클립보드 문단에 오른쪽 절반을 이어 붙인다 → **대상 문단의 나머지 텍스트가 클립보드 마지막 문단의 문단 모양을 갖게 된다.**

한글의 "문단 중간 붙여넣기"와 같은 의미론이지만, "문단 통째 이동"에 쓰면 **첫 문단의 문단 모양(번호 종류, 들여쓰기)이 도착 위치 문단 것으로 바뀌는** 문제가 생긴다. 그래서 문단 이동에는 `importParagraphBlock` 이 맞다.

### 2-3. 표

| 기능 | 메서드 | 근거 |
|---|---|---|
| 행/열 삽입 | `insertTableRow(sec, ppi, ci, row, below)`, `insertTableColumn(..., right)` | d.ts:1618, 1612, `wasm_api.rs:2244` |
| 행/열 삭제 | `deleteTableRow(sec, ppi, ci, row)`, `deleteTableColumn(...)` | d.ts:410, 398, `wasm_api.rs:2288` |
| 셀 텍스트 | `insertTextInCell(...)`, `deleteTextInCell(...)`, `getTextInCell(...)`, `*ByPath`(중첩 표) | d.ts:1635, 423, 1372 |
| 병합/분할 | `mergeTableCells`, `splitTableCell(Into)` | d.ts:1719, 2392 |
| 구조 | `getTableDimensions`, `getCellInfo`, `getTableCellBboxes` | d.ts:1343, 661, 1331 |

### 2-4. 자동 번호 모델

- 번호는 **문단 모양(`head_type` = Outline/Number/Bullet, `numbering_id`, `para_level`)** 에 있고, 숫자 자체는 저장하지 않는다.
- 렌더 때마다 번호 상태를 초기화하고 앞 구역·앞 쪽 문단을 다시 훑어 카운터를 복원한다(`src/document_core/queries/rendering.rs:7816-7860`, `src/renderer/layout.rs:4371,4431`).
- 따라서 **번호 문단을 옮기면 번호가 자동으로 다시 매겨진다.** 문서 끝에서 "1." 같은 번호를 직접 타이핑한 문단은 그냥 텍스트라 재계산되지 않는다.
- 조회: `getOutlineNavigation()`(개요 번호만, 번호 값 계산 포함, `queries/navigation.rs:283`, 번호 계산 `:118-137`), `getNumberingList()`, `getStructure(mode)`(개요 수준 또는 "제N조/①/1./가." 텍스트 패턴, `queries/structure.rs:1-27,612`).
- 조작: `setNumberingRestart(sec, para, mode, start)`, `insertNewNumber(...)`, `ensureDefaultNumbering()`, `createNumbering(json)` (d.ts:2267, 1566, 481, 285).

### 2-5. undo/redo, 스냅샷, 변경 이벤트

| 기능 | API | 근거 |
|---|---|---|
| 문서 스냅샷 | `saveSnapshot(): number`, `restoreSnapshot(id)`, `discardSnapshot(id)`, `snapshotCapacity()` | `wasm_api.rs:7209-7232` |
| 부분 되돌리기 | `captureDeleteRange` → `restoreDeleteFragment` | `wasm_api.rs:7240-7262` |
| 코어 이벤트 로그 | `getEventLog()` (ParagraphDeleted, ContentPasted 등) | `wasm_api.rs`(getEventLog), `text_editing.rs:4324`, `clipboard.rs:887` |
| 렌더 갱신 | 콜백 없음. 편집 메서드가 내부에서 reflow·paginate 하고, 호출자가 `renderPageToCanvas/Svg` 를 다시 부른다 | `text_editing.rs:4290`(`paginate_if_needed`) |
| studio undo | 스냅샷 기반 히스토리. 외부에서는 `commands.execute('edit:undo')`, `hwpctrl.undo()` | `rhwp-studio/src/command/commands/edit.ts:22-40` |
| studio → 호스트 변경 이벤트 | `onDocumentChanged` 는 **에이전트 apply/revert 만** 통지(`reason: 'agent_apply' \| 'agent_revert'`). **사용자 타이핑 등 일반 편집은 호스트에 알리지 않는다** | editor d.ts `RhwpDocumentChangedEventV1`, `rhwp-studio/src/main.ts:2047`, `document-agent/controller.ts:582,750` |

### 2-6. 구조 추출

`getSectionCount`, `getParagraphCount(sec)`, `getParagraphLength`, `getTextRange(sec,para,off,count)`, `getParaPropertiesAt`, `getStyleAt`, `getCharShapeRuns`, `getStructure`, `getOutlineNavigation`, `searchAllText(query, cs, includeCells)`, `getPageText(page)`, `getPageOfPosition(sec, para)`, `getFieldList`, `getBookmarks` (d.ts:1161, 1165, 1384, 1145, 1301, 738, 1295, 1054, 2058, 1129, 1113, 915, 619).
문단 주소는 `(section, paragraph)` 위치 인덱스뿐이라, **편집 후에는 인덱스가 바뀐다.** 안정 ID 는 우리 쪽에서 만들어야 한다.

### 2-7. 하이라이트·스크롤

| 수단 | 범위 | 근거 |
|---|---|---|
| `getSelectionRects(sec, sp, so, ep, eo)` | 줄별 사각형 `[{pageIndex,x,y,width,height}]` → **우리 뷰어에서 오버레이를 그리는 재료** | `wasm_api.rs:6708-6725` |
| `getCursorRect`, `getPageOfPosition`, `getSelectionRectsInCell(ByPath)` | 캐럿 위치, 쪽, 셀 안 범위 | d.ts:803, 1113, 1203 |
| editor `focusTarget(target)` | **본문 문단 하나 전체**를 선택하고 화면 가운데로 옮김(변경 없음) | editor d.ts, `rhwp-studio/src/document-agent/controller.ts:758-766`, `input-handler.ts:4938` |
| `rhwpDev.goto(hit)` | 범위 선택+스크롤. **dev 빌드 전용**(프로덕션 미포함) | editor README `rhwpDev` 절 |

임의 범위(문단 일부, 여러 곳 동시)를 iframe 에디터에서 하이라이트하는 공개 RPC 는 **없다.**

---

## 3. `@rhwp/editor` 에이전트 계약과 외부 조작 진입점

### 3-1. 전송

- `createEditor/createStudio` 가 iframe(rhwp-studio)을 만들고 `window.postMessage({type:'rhwp-connect'}, origin, [port2])` 로 **MessageChannel 포트**를 넘긴다. 이후 통신은 포트에서만 한다(`npm/editor/transport.js:74-102`, `rhwp-studio/src/embed/runtime.ts:171-223`).
- 첫 연결 origin 에 고정하고 단일 바인딩만 허용한다(`runtime.ts:184-217`). `studioUrl` 은 http(s) 만 된다(`transport.js:72-73`).
- RPC 메서드 전체(`rhwp-studio/src/embed/rpc-router.ts:128-219`): `ready, loadFile, pageCount, getRendererDiagnostics, getFontDecisionTrace, getPageSvg, exportHwp/Hwpx/Hml, getHmlSaveState, exportHwpVerify, notifySaved, getDocumentState, getSelectionContext, applyTextCommand, revertTextCommand, focusTarget, automation.{list,menuModel,isEnabled,execute,context}, plugin.{list,load,unload,invoke}, chrome.{get,set}`.
- **WASM 메서드를 일반 RPC 로 노출하지 않는다.** 모르는 메서드는 `Unknown method`(`rpc-router.ts:219`).

### 3-2. 문서 에이전트 exact command (`applyTextCommand`)

- 대상: `{kind:'body_paragraph', section, paragraph, charOffset:0, length}` — **본문 문단 하나 전체 교체만** (`mydocs/tech/wasm_agent_surface/document_agent_command.md:46-66`).
- 결속: epoch, changeSeq, 문서 SHA, 원문 SHA, 서식 SHA(`{charShapeId, paraShapeId, styleId}`), 앞뒤 문단 문맥 SHA (`:68-110`).
- 제약: 최대 4,000자, plain text 만. **컨트롤·필드·글자 모양이 섞인 문단은 `TARGET_FORMAT_MISMATCH`**. 표 셀, 머리말, 각주, 글상자 불가. 적용 후 **쪽 수가 바뀌면 롤백**(`:56-66`, `:118-126`).
- 되돌리기: 가장 최근 명령만 `revertTextCommand`. 그 뒤 다른 편집이 있으면 거부(`:128-133`).
- 평가: 우리 용도에서는 "특정 문단 문구 다듬기"에는 쓸 수 있다. **이동·삽입·삭제·표 편집에는 못 쓴다.** 실제 공문은 글자 모양이 섞인 문단이 많아 대상이 크게 줄어든다.

### 3-3. `createStudio` + 자동화·플러그인·HwpCtrl

- `createStudio('#app', {plugins:['hwpctrl'], chrome:{...}})` → `studio.commands.execute(id)`, `studio.hwpctrl.call/batch`, `exportBytes`, `undo/redo` (editor d.ts `RhwpEditor.commands/plugins/hwpctrl/chrome`, `npm/editor/index.js:391-452`, README "createStudio" 절).
- `hwpctrl` 은 **studio 가 들고 있는 같은 문서**를 빌려 쓴다. 변경 호출은 `host.transaction` 으로 감싸 **배치 1건 = undo 1스텝 = 재조판 1회**이고 화면에 바로 반영된다(`npm/hwpctrl-ocx/src/studio-plugin.mjs:1-12, 36-75`).
- 지원 범위: 웹한글컨트롤 API v2.4 원장 484항목 중 verified 333 (`npm/hwpctrl-ocx/spec/api_ledger.json` summary). `SetPos/GetPos/MovePos/SelectText/GetSelectedPos`, `InitScan/GetText`, `GetTextFile/SetTextFile`, `PutFieldText`, `Run("Delete"|"BreakPara"|"MoveSelParaEnd"|"TableAppendRow"|"TableDeleteRow"…)` 등 (`npm/hwpctrl-ocx/src/index.mjs:380-562, 2050-2344`).
- **없는 것**: `Run("Cut")`, `Run("Paste")`, `Run("Copy")` 액션이 없다(원장·액션 표 모두 0건). `GetHeadingString`(번호 문자열)은 unimplemented.
- `commands.execute('edit:cut'|'edit:paste')` 는 있지만 내부가 `document.execCommand('cut'|'paste')`(`rhwp-studio/src/engine/input-handler.ts:5583-5601`)라, **사용자 제스처 없이 프로그램으로 붙여넣기는 브라우저가 막을 가능성이 크다** [추정: 실행 확인 안 함]. 대화상자를 여는 명령은 기본 거부된다(README).
- `@rhwp/hwpctrl` 패키지 자체는 `private` 0.0.0 이라 npm 단독 설치는 안 되고, studio 번들(`__RHWP_HWPCTRL__`)에 들어 있어야 한다(`npm/hwpctrl-ocx/package.json:3-7`, `rhwp-studio/src/main.ts:303-318`). 프로덕션 플러그인 allowlist 는 `hwpctrl` 하나뿐이다.

---

## 4. 외부(로컬 서버)와 통신하는 기존 경로

| 대상 | 결과 | 근거 |
|---|---|---|
| studio ↔ 로컬 서버(WebSocket/HTTP) | **없음.** studio 의 WebSocket 은 dev 전용 핫패치(`/_dioxus`)뿐 | `rhwp-studio/src/core/subsecond-runtime.ts:455-466` |
| studio 문서 로드 | `?url=`·samples 경로 `fetch` 만(읽기) | `rhwp-studio/src/main.ts:865,1929-1940` |
| Chrome 확장 | `localhost`·사설 IP·단일 라벨 호스트 fetch **차단**. `nativeMessaging`·`externally_connectable` 없음 | `rhwp-chrome/sw/fetch-security.js:125-139`, `rhwp-chrome/README.md:123`, `rhwp-chrome/manifest.json:32-41` |
| 확장 내부 메시징 | `chrome.runtime` 메시지 + 기본 거부 발신자 검증(별개 계보) | `browser_bridge.md:163-176` |
| VS Code 확장 | webview postMessage(내보내기 등) | `rhwp-vscode/src/hwp-editor-provider.ts:33-109` |
| 브라우저 MCP 브리지 | **설계 문서만 있음**(MessageChannel 위 JSON-RPC, 조각 B1~B7 미구현). `mcp-jsonrpc-v1` capability 0건 | `mydocs/tech/wasm_agent_surface/browser_bridge.md:23-44, 482-497` |
| `src/native_host/` | 브라우저 없는 데스크톱 호스트 계층(rhwp-desk 용). 네트워크 아님 | `src/native_host/mod.rs:1-4` |

---

## 5. 결론

### 5-1. 이미 주는 것 / 없는 것 / 우리가 만들 것

| 구분 | 내용 |
|---|---|
| **이미 있음** | WASM 편집 엔진(문단 삽입·삭제·분할·병합, 블록 복제, 표 행/열·셀, 서식, 번호 재시작, 스냅샷), 렌더(Canvas/SVG), 범위 사각형(`getSelectionRects`), 구조·검색·개요 질의, HWP/HWPX 저장. 읽기·추출에 강한 stdio MCP(`hwp_doc_search/structure/tables/extract_data`). iframe 에디터 + HwpCtrl 호환 프로그램 편집 + 문단 교체 계약 |
| **없음** | ① MCP ↔ 브라우저 연결(네트워크 전송 자체가 없음) ② 문단 이동 API ③ 안정 문단 ID ④ 임의 범위·다중 하이라이트 RPC ⑤ 일반 편집 변경 이벤트(사용자 편집 → 호스트) ⑥ iframe 에디터에서 서식 보존 잘라내기/붙여넣기 RPC |
| **만들 것** | (a) 로컬 MCP 서버(Node/TS, stdio) + 같은 프로세스의 **WebSocket(127.0.0.1, 토큰)** (b) 브라우저 뷰어: `@rhwp/core` 직접 사용, 문서 상태의 **단일 권위는 브라우저**(MCP 는 명령 중계·결과 반환) (c) 명령 집합: `get_outline`, `find`, `get_paragraphs(range)`, `move_paragraphs`, `replace_paragraph_text`, `insert_paragraph_after`, `delete_paragraphs`, `table_*`, `highlight(ranges)`, `undo`, `save` (d) **안정 ID 층**: 로드 시 문단마다 UUID 를 붙이고 편집 명령마다 인덱스 맵을 갱신, LLM 에는 `p:<uuid>` + 텍스트 + 문맥 SHA 로 준다(rhwp exact command 의 SHA fence 패턴 차용) (e) 근거 하이라이트: `searchAllText` → `getSelectionRects` → 캔버스 위 오버레이 + 스크롤 (f) 사용자 직접 편집 감지(우리 뷰어가 편집 API 를 감싸므로 직접 발행) |

### 5-2. 새로 만들기 vs rhwp MCP 확장

**추천: 새로 만들기 (엔진 재사용, MCP 포크 안 함).**

| 기준 | 새로 만들기 (TS MCP + 브라우저 `@rhwp/core`) | rhwp MCP 포크/확장 |
|---|---|---|
| 실시간 뷰어 반영 | 문서가 브라우저 메모리 한 벌. 편집 즉시 다시 그림 | Rust 서버의 IR 과 브라우저 IR 이 **두 벌**. 동기화(바이트 재전송 또는 명령 재실행)를 새로 짜야 함 |
| 구현 언어 | TS 하나(MCP SDK + ws + 뷰어) | Rust(mcp_serve.rs 직접 JSON-RPC) + TS 뷰어 둘 다 |
| 업스트림 정합 | npm 버전만 고정하면 됨 | `mcp_serve.rs`·도구 선언 드리프트 계약 테스트(`tests/mcp_server_contract.rs`)·200개 가까운 도구 목록을 계속 따라가야 함. main(10-06)과 devel(10-23) 사이에도 계속 바뀌는 레포라 포크 유지비가 큼 |
| 업스트림 방향 | 로드맵이 "업무 화면·서비스는 다운스트림"이라고 명시(선행 보고서 1-7) → 다운스트림 앱이 정석 | 브라우저 브리지는 업스트림 M24 설계(MessageChannel, 단일 origin)와 방향이 다름(로컬 WS 서버를 넣자는 제안은 보안 경계 문서와 부딪힐 가능성) |
| 읽기 품질 | 필요하면 `rhwp mcp-serve` 를 **같이 등록**해 추출·검색·조문 구조를 그대로 씀(파일 경로 기반, 저장본 기준) | 동일 |

기여할 만한 것(작은 PR/이슈): `moveParagraphBlock`(같은 문서, `repeat_paragraph_block` 경로 재사용 + 원본 삭제를 한 트랜잭션), embed RPC 의 `highlightRanges`/`focusRange`, 일반 편집 `documentChanged` 이벤트. 받아들여지면 iframe 에디터만으로도 구상이 성립한다.

뷰어 선택 메모: `@rhwp/editor` iframe 을 쓰면 메뉴·툴바·IME 편집을 공짜로 얻지만, 위 ①~⑥ 공백 때문에 이동·하이라이트를 못 한다. **`@rhwp/core` 직접 사용 뷰어(보기 + 우리 명령)로 시작**하고, 사람이 손으로 고칠 일이 많아지면 그때 studio 포크(같은 origin 에서 `rpc-router.ts` 에 메서드 몇 개 추가)를 검토하는 순서가 맞다. studio 포크는 `rpc-router.ts`(221줄)·`runtime.ts`(231줄) 수준의 작은 표면이라 MCP 포크보다 훨씬 싸다.

### 5-3. "문단 이동" 구현안과 리스크

**가능하다.** `@rhwp/core` 를 직접 쓰는 뷰어 기준 절차:

1. `snap = doc.saveSnapshot()`
2. 원본 사본 만들기: `src = new HwpDocument(doc.exportHwp())` (HWPX 원본이면 `exportHwpx`). `importParagraphBlock` 은 **다른 핸들**만 받는다(`template_automation.rs:7`).
3. `doc.importParagraphBlock(src, JSON.stringify({request:{sourceSection:s, sourceStart:a, sourceEnd:b, targetSection:s, insertBefore:t, count:1}, dryRun:true}))` 로 사전 검증 → 통과하면 `dryRun:false` 로 실행.
4. 원래 문단 삭제: `t <= a` 면 원본 인덱스가 `b-a` 만큼 밀리므로 `[a+(b-a), b+(b-a))`, `t >= b` 면 `[a, b)` 를 뒤에서부터 `deleteParagraph` (구역 마지막 문단은 삭제 불가 → 경계 처리).
5. 실패하면 `restoreSnapshot(snap)`. 성공하면 다시 렌더 + 옮긴 범위 `getSelectionRects` 하이라이트.
6. 검증: 이동 전후 문단 텍스트 다중집합 동일, 대상 범위 `paraShapeId`·`charShapeRuns` 동일, `getOutlineNavigation()` 번호 순서 확인.

리스크:

| 리스크 | 내용 | 대응 |
|---|---|---|
| 블록 복제 거부 | 각주·미주·책갈피·하이퍼링크·AutoNumber·NewNumber·양식·차트·OLE 가 든 문단은 `unsupported` 로 거부(`validation/support.rs:252-278`) | dryRun 결과로 "이 문단은 옮길 수 없음(각주 포함)"을 사용자에게 알림. 대안 경로(copySelection+pasteInternal)는 서식이 바뀌므로 경고 후 선택 실행 |
| 번호 | 개요/문단 번호는 렌더 시 재계산되므로 **자연히 다시 매겨진다**. `NewNumber`(새 번호로 시작)·번호 재시작 설정이 걸린 문단은 거부되거나 의도와 다른 결과 | 이동 전후 `getOutlineNavigation()` 비교를 응답에 포함 |
| 수기 번호 | "1. 2. 3." 을 직접 타이핑한 문서는 재계산 안 됨 | `getStructure('clause')` 로 감지해 "번호를 고칠까요?" 후속 제안 |
| 문단 경계 이동 | 문단 일부만 옮기기(범위)는 블록 복제로 안 됨 → `split` 으로 경계를 먼저 만든 뒤 블록 이동, 또는 copy/paste 경로 | 1차 범위는 "문단 단위"로 제한 |
| 구역 첫 문단·쪽 나누기 | 구역 시작 표식·쪽/단 나누기는 문단을 따라가거나 자리에 남음(`text_editing.rs:4375-4392`) | 구역 첫 문단 이동은 별도 검증 |
| 인덱스 기반 주소 | 이동 후 모든 뒤 인덱스가 바뀜 | 우리 안정 ID 층에서 매 명령 후 재매핑 |
| 저장 호환 | 편집 문단의 lineseg 처리·HWPX 저장 드리프트는 선행 보고서 1-5 의 리스크 그대로 | 저장 후 한글에서 열어 보는 골든 테스트 |
| 메모리 | 이동마다 문서 전체 사본(`exportHwp` + 파싱)이 필요 | 큰 문서는 사본을 캐시하고 편집마다 갱신, 또는 업스트림에 같은 문서 이동 API 기여 |

`@rhwp/editor`(iframe)만 쓰는 경우: 공개 RPC 로는 서식 보존 이동이 **불가**하다. `hwpctrl` 로 `SelectText` → 텍스트 읽기 → `Run("Delete")` → 목적지에 텍스트 삽입은 되지만 글자 모양·표·그림이 사라진다.

---

## 출처 (파일)

- MCP: `src/mcp_serve.rs`, `src/cli/metadata/mcp/{mod,read,edit_content,edit_structure,edit_format,exchange,advanced,protocol}.rs`, `.mcp.json`, `README.md:183-258`, `mydocs/manual/mcp_integration_guide.md`, `.github/workflows/release-binary.yml`
- WASM: `src/wasm_api.rs`, `src/wasm_api/template_automation.rs`, `src/document_core/commands/{text_editing,clipboard}.rs`, `src/document_core/commands/paragraph_block/{import,repeat,template,template_operation}.rs`, `.../validation/support.rs`, `src/model/paragraph.rs`, `src/document_core/queries/{navigation,structure,rendering}.rs`, `src/renderer/layout.rs`
- 에디터/studio: `npm/editor/{index.js,index.d.ts,transport.js,document-agent-contract.js,README.md}`, `rhwp-studio/src/embed/{rpc-router,runtime,protocol}.ts`, `rhwp-studio/src/document-agent/controller.ts`, `rhwp-studio/src/engine/input-handler.ts`, `rhwp-studio/src/command/commands/edit.ts`, `rhwp-studio/src/main.ts`, `npm/hwpctrl-ocx/{src/index.mjs,src/studio-plugin.mjs,spec/api_ledger.json,package.json}`
- 설계 문서: `mydocs/tech/wasm_agent_surface/{README,browser_bridge,document_agent_command}.md`
- 확장: `rhwp-chrome/{manifest.json,sw/fetch-security.js,README.md}`, `rhwp-vscode/src/hwp-editor-provider.ts`
- npm 0.8.7: `rhwp-npm/rhwp-core-0.8.7/package/rhwp.d.ts`, `rhwp-npm/rhwp-editor-0.8.7/package/index.d.ts`
