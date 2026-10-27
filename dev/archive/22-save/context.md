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
- 2026-10-27 #19(PR #26, 69ef30f) 머지 뒤: 이전 커밋들을 main 위로 한 번에 옮김(패치 적용 + 충돌 해결, 백업 브랜치 로컬 `backup/22-save-pre-rebase`).
  - 편집 경로 연결: `session.edit`·`undo`·`recordSave` 가 줄 안에서 `pushEditState` → 뷰어 `edit_state`. 편집 도구는 손대지 않음.
  - 저장도 `session.exclusive` 로 같은 줄(편집 전 id 표 사본·뷰어 스냅샷·저장 상태가 한 시점). 그래서 "쓰는 사이 다른 문서" 분기는 없앰. 줄 안에서는 `requestViewer`(ready 를 기다림)를 쓰면 막혀서 `send` 를 넘긴다.
  - 새로고침: 서버는 `new EditLog()`(depth 0), 뷰어는 load_document 로 새 `DocumentEditor`(depth 0). 테스트로 다음 replace_text·undo 확인.
  - 되돌리기 칸 중복: `core/bounded-stack.ts` 로 합침(EditHistory·EditLog).
  - 테스트 편집은 실제 replace_text·undo. id 표를 옮기는 편집(#20 넣기)은 아직 없어 서버 id 표만 흉내낸 테스트 하나.
- 2026-10-27 PR #25 재리뷰: 원본 판정은 .hwpx 붙인 뒤 + 링크 따라간 inode, writeSave 도 `protectedPath` 로 쓰기 직전 재확인. overwrite 임시 파일은 realpath 폴더. 복사 대체 실패 시 대상 삭제. overwrite 는 path 있을 때만. `~` 처리 `server/paths.ts`. 새로고침 load 실패(문서 비움)도 알림. 편집·undo 요청 params 에 `unsavedEdits`(EditLog.unsavedAfterRecord/AfterUndo) — 덜 되돌렸을 때만 edit_state 따로. `syncViewerEditState` 삭제.
