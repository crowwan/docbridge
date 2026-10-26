# #6 컨텍스트

- 이슈: https://github.com/crowwan/docbridge/issues/6 (부모 #3, 스펙 SPEC-001)
- 기반: #4(PR #10) 블록 추출·id 표, #5(PR #11) 세션 큐·`session.requestViewer` 공용 경로
- 관련 파일: `src/core/{blocks,block-ids,block-schema,find-text}.ts`, `src/shared/protocol.ts`, `src/server/{reading,read-tools,mcp}.ts`, `src/viewer/main.ts`, `tests/`, `e2e/read-tools.spec.ts`

## 결정·발견

- 2026-10-26 getSectionStarts(rhwp def947c `hwpctrl_sets.rs:2014`)는 "본문 첫 문단 또는 첫 컨트롤이 SectionDef 인 문단" 번호. 빈 문서에 breakAtCursor('section') 하면 `getSectionCount()=1` 인데 `[0,1]`. getControls 의 `para`(물리 구역을 이은 번호)와 맞추는 데 쓰면 표가 없는 구역 1 로 간다 → 쓰지 않음.
- 누름틀 값은 문단 텍스트에 포함(getFieldList startCharIdx..endCharIdx). find 는 문단·칸만.
- 머리말·각주는 본문 문단 텍스트(getTextRange)에 들어가지 않는다(빈 문서에 createHeaderFooter·insertFootnote 로 확인).
