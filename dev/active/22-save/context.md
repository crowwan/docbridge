# #22 컨텍스트

- 관련 파일: `src/core/hwpx-export.ts`, `src/shared/protocol.ts`, `src/server/{session,save-path,save-tool,mcp}.ts`, `src/viewer/main.ts`, `tests/`, `e2e/save.spec.ts`
- 병렬: #19(편집 기반, `feat/19-edit-core`) 3c151ff 위로 rebase 해서 그 `EditLog`(record·undo·markSaved·editCount·unsavedEdits·dirty)와 `OpenedDocument.edits` 를 쓴다.

## 결정·발견

- 2026-10-27 "원본" = open_document 로 연 파일(`OpenedDocument.sourcePath`). 저장 뒤에도 그대로라 두 번 저장하면 `-수정`, `-수정-2`. `path`(마지막 파일)는 저장 경로로 바뀐다.
- 상대 경로는 원본 폴더 기준(MCP 서버 프로세스의 cwd 는 Claude Desktop 이 정해 사용자가 모른다). 확장자 없으면 `.hwpx` 붙이고 다른 확장자는 거부. 원본 판별은 dev+ino(대소문자만 다른 경로).
- 검증 실패 결과는 다른 블록의 "순서"만 준다. 누름틀 id 는 같은 문단 안 누름틀 순서로 갈려(`anchorsOf`) 일부 위치만 label 하면 틀리므로, 결과에 블록 위치 전체를 싣고 서버가 전부 label 한 뒤 고른다.
- 뷰어 → 서버 base64 JSON. 50MB(=열기 상한, `shared/limits.ts`) 를 넘으면 뷰어가 보내지 않음. ws 기본 maxPayload 100MB 안(67MB). 서버도 길이·상한 다시 확인.
- 쓰기: 같은 폴더 임시 파일(`.<이름>.<8자>.docbridge-tmp`, `wx`) → rename. 덮어쓰지 않는 경우에도 경로 검사와 rename 사이에 누가 같은 이름을 만들면 덮어쓴다(경쟁 — link 로 막을 수 있지만 exFAT 등에서 안 돼 두지 않음).
- 새로고침: 사라진 편집 = `edits.unsavedEdits`(#19, 저장 뒤 되돌린 것도 셈). 있으면 id 표를 `savedIds.clone()`, 없으면 지금 표 그대로(기존 테스트의 같은 객체 단언 유지). 편집 기록은 항상 새로. 알림은 세션 `notices` → mcp.ts 가 다음 도구 결과 content 뒤에 글 한 덩이로(성공·오류 모두, 한 번).
- (PR #25 리뷰로 바꿈) 뷰어는 저장하지 않은 편집을 세지 않는다. 서버 `EditLog.unsavedEdits` 가 기준이고 `session.syncViewerEditState()` 가 뷰어 요청 `edit_state { fileName, unsavedEdits }` 로 보낸다(저장 뒤, #19 머지 뒤 편집·undo 뒤). 처음 만든 `noteEdit`·`document_saved` 는 없앰 — 저장 뒤 undo 하면 서버 1·뷰어 0 으로 어긋났다.
- beforeunload 확인 창은 브라우저 고유 창이라 page.screenshot 에 안 찍힌다. E2E 는 `dialog.type() === 'beforeunload'` 로 확인. 페이지를 한 번 눌러야(사용자 활성화) 뜬다.
