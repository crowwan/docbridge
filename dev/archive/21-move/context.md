# #21 컨텍스트

- 병렬: #20 넣기·지우기(`feat/20-insert-delete`, block-ids.ts 넣기·지우기 갱신과 document-editor 위치 옮기기가 겹칠 수 있음 — main 기준 rebase), #22 저장
- E2E 포트 `DOCBRIDGE_E2E_PORT=7850`
- 관련 파일: `src/core/{block-ids,edit-operations,document-editor,edits}.ts`, `src/server/{move-plan,edit-tools,mcp}.ts`, `tests/{move-plan,document-editor,edit-tools,block-ids}.test.ts`, `e2e/edit-tool.spec.ts`

## 발견

- 2026-10-27 편집 공용 경로의 빈 문단 유지 위치를 옮기지 않으면, 표 문단을 옮겼을 때 표 문단 자리에 빈 문단 블록이 생긴다(remap 필요, 테스트로 고정). #20 넣기·지우기도 remap 으로 같은 문제를 풀 수 있다.
- rhwp `breakAtCursor(…, 'section')` 는 구역 수를 늘리지 않았다 → 다른 구역 거부는 id 표만으로 테스트.
- 각주만 든 빈 문단은 블록이 아니다 → 거부 문구는 "<앞 블록 id> 뒤 빈 문단".
- 빈 문서에 각주를 넣어 HWPX 로 저장해 열어도 각주 거부가 그대로 나온다(MCP 단 AC-5 테스트, 주입 불필요).
- 2026-10-27 PR #28 리뷰 반영 뒤 #20 머지(3329e00)로 최종 rebase. 충돌이 커서 브랜치를 한 커밋으로 합쳐 rebase 함(리뷰 반영 전 커밋은 로컬 `backup/21-move-pre-final`: c47baaa·19c8db9·acd366c·4eb1cfb·f9bf1f3).
- `EditApplied.remap` 을 없애고 #20 의 `ParagraphChanges` 에 `moved` 를 더해 relocate·id 표가 같이 쓴다. 서버 id 표는 뷰어가 돌려준 `changes.moved` 로 옮긴다.
- 번호가 바뀐 문단 표시는 편집 공용 경로 공용이라 지우기(#20)에서도 "나." → "가." 문단이 바뀐 블록이 된다(#20 테스트 기대 갱신).
