# #21 문단 옮기기 move_blocks

- 이슈: https://github.com/crowwan/docbridge/issues/21 (부모 #17, SPEC-002 AC-4·5·6, ADR 002 "문단 옮기기")
- 기반: #19(PR #26) 편집 공용 경로, #18 `moveParagraphs`·`BlockIdTable.paragraphsMoved`

## 구성

1. **서버가 계획한다**(`src/server/move-plan.ts` `planMove`): id 표가 뷰어 블록 위치와 같으므로, 이어짐·구역·누름틀 단독·기준 위치·이미 그 자리 검사를 id 표로 하고
   옮길 문단 범위 `[start, end)`·`before` 를 정한다. 오류에 사이 블록 id 처럼 서버만 아는 id 를 담을 수 있다.
2. **뷰어가 옮긴다**(`edit-operations.ts` case `move_blocks`): 받은 블록 위치가 뷰어 블록에 있는지 확인 → `moveParagraphs`
   → 거부면 스펙 문구(블록 id 는 요청에 실려 온다)로 던져 스냅샷 복원·기록 안 함. 성공하면 옮긴 문단과 위치 옮기기(`remap`).
3. **편집 공용 경로**(`document-editor.ts`): `EditApplied.remap`(옛 위치 → 새 위치)으로 빈 문단 유지 위치를 옮기고,
   번호가 바뀐 문단을 바뀐 블록에 더한다(#20 넣기·지우기도 같은 remap 을 쓸 수 있다).
4. **id 표**: 서버가 뷰어 성공 뒤 `paragraphsMoved`. 위치 옮기기 계산은 `movedParagraphIndex` 하나를 뷰어·id 표가 같이 쓴다.
5. **결과**: `{ moved, changed: [{ id, number?, text }], warnings? }` — 직접 입력 번호 경고는 서버가 옮긴 문단 글자로.
