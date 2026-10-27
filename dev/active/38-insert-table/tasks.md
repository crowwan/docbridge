# #38 작업

- [x] 스펙 먼저(기준 규칙·결과 inserted/cells/changed·크기 거부 문구·표 안 표·변경 이력) [✅ 2026-10-27 14:00]
- [x] 편집 종류 insert_table, ParagraphChanges.inserted tableControlIndex, id 표 tablePart·세션, 표 문단 빈 블록 안 남김 [✅ 2026-10-27 14:05]
- [x] 도구 등록·결과, 테스트(AC-6 11개 + id 표 1개), 대상 줄 지워 실패 확인(16개 변형 모두 실패) [✅ 2026-10-27 14:15]
- [x] E2E(DOCBRIDGE_E2E_PORT=7870, 47개 통과)·스크린샷, 문서(CLAUDE.md·ADR 003) [✅ 2026-10-27 14:20]
- [x] PR #44·확인 기록(assets 975f166 pr/44)·CI 통과 [✅ 2026-10-27 14:30]
- [x] PR #44 리뷰 반영(예상 밖 문단 거부·저장 왕복 테스트·inserted part·크기 검사 순서·정수 아님 문구) [✅ 2026-10-27 14:50]
- [x] #43·#45 머지 뒤 main 으로 rebase(커밋 하나로 합쳐 rebase, styles.ts import, 결과 changed 는 NumberedItem) [✅ 2026-10-27 15:30]

## 발견

- 표 문단을 keepEmpty 로 남기면 뷰어에만 빈 문단 블록이 생겨(서버 id 표에 없음) move_blocks 가 그 범위를 "뷰어에만 있는 블록" 으로 거부한다 → document-editor 가 표 문단은 남기지 않는다(테스트로 고정)
