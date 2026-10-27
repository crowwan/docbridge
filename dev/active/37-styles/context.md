# #37 컨텍스트

- 이슈: https://github.com/crowwan/docbridge/issues/37 (부모 #34, SPEC-003, ADR 003)
- 기반: #35(PR #40) 프로토타입 `src/core/create-document.ts`. 병렬: #36 create_document(7880), #38 insert_table(7870), #41/#42 버그 수정(7890). 머지 순서: 버그 수정 → #37 → #38 → #36
- 관련 파일: `src/core/{styles,create-document,edit-operations}.ts`, `src/server/{style-tools,edit-tools,mcp}.ts`, `src/shared/protocol.ts`, `src/viewer/main.ts`, `tests/{styles,style-tools,create-spike}.test.ts`, `tests/rhwp-viewer.ts`, `e2e/edit-tool.spec.ts`
- E2E 포트 `DOCBRIDGE_E2E_PORT=7860`

## 발견
