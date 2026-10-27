# #37 컨텍스트

- 이슈: https://github.com/crowwan/docbridge/issues/37 (부모 #34, SPEC-003, ADR 003)
- 기반: #35(PR #40) 프로토타입 `src/core/create-document.ts`. 병렬: #36 create_document(7880), #38 insert_table(7870), #41/#42 버그 수정(7890). 머지 순서: 버그 수정 → #37 → #38 → #36
- 관련 파일: `src/core/{styles,create-document,edit-operations}.ts`, `src/server/{style-tools,edit-tools,mcp}.ts`, `src/shared/protocol.ts`, `src/viewer/main.ts`, `tests/{styles,style-tools,create-spike}.test.ts`, `tests/rhwp-viewer.ts`, `e2e/edit-tool.spec.ts`
- E2E 포트 `DOCBRIDGE_E2E_PORT=7860`

## 발견
- 2026-10-27 rhwp `getStyleDetail` 은 스타일 문단 모양에 번호가 없으면 그 스타일을 쓰는 번호 문단의 모양을 준다(`find_effective_para_shape_for_style`). report.hwpx(모든 문단이 바탕글 + 직접 개요 모양)에서 바탕글이 개요 1 로 나왔다 → 돌려준 paraShapeId 가 스타일 것일 때만 개요로 본다.
- report.hwpx 의 개요 문단은 직접 모양(굵게, 들여쓰기 없음)이라, set_style 개요 1 을 건 문단은 rhwp 기본 개요 1 모양(들여쓰기, 보통 굵기)으로 보인다 — 스펙대로(스타일 모양).
- 대상 줄 지우기 9개 변형 모두 실패 확인(styles 개요 판정·insert style 덮기·resetToStyle→applyParagraphStyle·set_style 적용·서버 거부·style 전달·outline 플래그·assertStylable·setParaShapeId).
- E2E `DOCBRIDGE_E2E_PORT=7860` 48개 통과(새 e2e/style-tool.spec.ts 2개).
- 2026-10-27 PR #45 리뷰 반영: styleIdByName → findStyle(정의 반환, 한글 이름 먼저·빈 이름·영문 모호 거부)·styleById, apply/reset 은 StyleEntry 를 받음(getStyleList 다시 안 읽음), insert style 은 기준 모양 복사 건너뜀(matchReference), insert 결과 number, numberedItem 은 outlineItem 사용·NumberedItem. 변형 5개 모두 실패 확인.
