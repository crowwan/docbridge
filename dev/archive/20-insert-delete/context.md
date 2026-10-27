# #20 컨텍스트

- 이슈: https://github.com/crowwan/docbridge/issues/20 (부모 #17, SPEC-002, ADR 002)
- 기반: #19(PR #26) 편집 공용 경로. 병렬: #21 move_blocks(`feat/21-move`, block-ids.ts·edit-operations.ts·document-editor.ts 겹침), #22 save(`feat/22-save`)
- 관련 파일: `src/core/{edit-operations,document-editor,block-ids,edits}.ts`, `src/server/{edit-tools,mcp}.ts`, `tests/{document-editor,edit-tools,block-ids}.test.ts`, `e2e/edit-tool.spec.ts`
- E2E 포트 `DOCBRIDGE_E2E_PORT=7840`

## 발견

- 2026-10-27 rhwp: `deleteParagraph(표 문단)` 은 표째 지움, `deleteTableControl` 은 표만(문단 남음), `deleteParagraph(0)` 은 secd·cold 컨트롤까지 지움(HWPX 내보내기에서 다시 생김), 하나 남은 문단은 "구역의 마지막 문단은 삭제할 수 없습니다".
- fixture 의 표 문단은 모두 글자가 없다(notice b12·report·application·outline-demo).
