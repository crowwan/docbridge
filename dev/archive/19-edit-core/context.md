# #19 컨텍스트

- 이슈: https://github.com/crowwan/docbridge/issues/19 (부모 #17, 스펙 SPEC-002, ADR 002)
- 기반: #18(PR #24) edits.ts·edit-history.ts, SPEC-001 TextTarget·id 표·세션 줄
- 병렬: #22 저장(PR #25, `feat/22-save`) — 세션 편집 상태 인터페이스(커밋 3c151ff)를 먼저 push 해 넘김. #22 는 저장 때 `edits.markSaved()`, 새로고침(AC-14), 뷰어 `noteEdit()`(탭 닫기 확인 창)를 맡는다
- 관련 파일: `src/core/{edit-operations,document-editor,block-schema,block-ids,highlight-targets}.ts`, `src/server/{edit-tools,edit-log,session,mcp,reading,highlight-tools}.ts`, `src/shared/protocol.ts`, `src/viewer/{main.ts,tokens.css,viewer.css}`, `tests/{edit-log,document-editor,edit-tools,open-document,protocol}.test.ts`, `tests/rhwp-viewer.ts`, `e2e/edit-tool.spec.ts`

## 발견

- 2026-10-27 TextTarget·anchor 스키마를 core/block-schema.ts 로 옮김(core 편집 코드가 shared 를 import 하지 않게). protocol 은 다시 내보낸다.
- rhwp 문서 메서드를 테스트에서 바꿔 끼워(doc.deleteText = 던짐) 편집 중간 실패를 결정적으로 만들 수 있다.
- 자동 번호("3.")는 글자 밖이라 문단 테두리가 번호 바로 오른쪽을 지난다(design.md 에 적음).
- E2E 는 `DOCBRIDGE_E2E_PORT=7820`(#22 와 병렬).
- #22 머지 후 뷰어 applyEdit·undoEdits 에서 noteEdit() 연결 필요(#22 가 rebase 할 때).
