# #6 컨텍스트

- 이슈: https://github.com/crowwan/docbridge/issues/6 (부모 #3, 스펙 SPEC-001)
- 기반: #4(PR #10) 블록 추출·id 표, #5(PR #11) 세션 큐·`session.requestViewer` 공용 경로
- 관련 파일: `src/core/{blocks,block-ids,block-schema,find-text}.ts`, `src/shared/protocol.ts`, `src/server/{reading,read-tools,mcp}.ts`, `src/viewer/main.ts`, `tests/`, `e2e/read-tools.spec.ts`

## 결정·발견

- 2026-10-26 getSectionStarts(rhwp def947c `hwpctrl_sets.rs:2014`)는 "본문 첫 문단 또는 첫 컨트롤이 SectionDef 인 문단" 번호. 빈 문서에 breakAtCursor('section') 하면 `getSectionCount()=1` 인데 `[0,1]`. getControls 의 `para`(물리 구역을 이은 번호)와 맞추는 데 쓰면 표가 없는 구역 1 로 간다 → 쓰지 않음.
- 누름틀 값은 문단 텍스트에 포함(getFieldList startCharIdx..endCharIdx). find 는 문단·칸만.
- 머리말·각주는 본문 문단 텍스트(getTextRange)에 들어가지 않는다(빈 문서에 createHeaderFooter·insertFootnote 로 확인).
- find 범위는 JS 문자열(UTF-16) 위치. 한글은 rhwp 글자 위치와 같다. BMP 밖 글자(이모지 등)에서 어긋날 수 있음 → #7 highlight 에서 변환 때 확인.
- 뷰어는 열 때 뽑은 블록(currentBlocks)을 들고 있다(읽기 전용 v0.1). SPEC-002 편집 때 다시 뽑아야 한다.
- `z.object({})` 는 `Record<string, never>` 로 추론된다. 제네릭 인덱싱(`schemas[method].parse`)은 TS 가 M 과 연결하지 못해 `parseViewerResult` 맵(메서드 → parse 함수)으로 둠.
- find_text 결과 수에 상한이 없다(한 글자 검색이면 많을 수 있음) — 스펙에 없어서 두지 않음, PR 확인 못 한 것에 적음.
- 2026-10-26 조율자: find_text 결과 = TextTarget({ id, cell?: { row, col }, start?, end? }) + before·after 로 고정(#7 과 병렬). 처음 만든 평평한 row·col 을 cell 로 바꿈.
