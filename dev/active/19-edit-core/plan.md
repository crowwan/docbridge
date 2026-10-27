# #19 편집 기반과 글자 바꾸기 — 계획

범위: SPEC-002 AC-1(replace_text), AC-7(다시 그리기·바뀐 블록 표시), AC-8(undo), AC-12(새 문서 열 때 버린 편집 수).

## 설계 (편집 공용 경로)

```
MCP replace_text(target, text) / undo(steps)
  └ server/edit-tools.ts
       │ session.edit(이름, 문서 → EditOperation, id 표 옮기기?)   ← #20·#21 도 이것을 부른다
       │ session.undo(steps)
       ▼
     server/session.ts  (문서 열기와 같은 줄에 세워 하나씩)
       │ 편집 전 id 표 사본 → 뷰어 'edit' 요청 → 성공하면 updateIds(ids) → EditLog.record(이름, 사본)
       │ 'undo' 요청 → 뷰어가 되돌린 수만큼 EditLog.undo → id 표 = 그 편집 전 사본
       ▼
     뷰어 viewer/main.ts  'edit' { operation } / 'undo' { steps }
       │ core/document-editor.ts DocumentEditor.edit:
       │   스냅샷(EditHistory.apply) → core/edit-operations.ts applyEdit(kind 판별 유니언)
       │   → 블록 다시 뽑기 → 바뀐 블록 { anchor, block }   (던지면 스냅샷 복원·무변경)
       │ 다시 그리기(보던 자리 유지) → core/highlight-targets.ts blockBoxes → .edit-mark 초록 테두리
       ▼
     { changed: [{ anchor, block }], pageCount } → 서버가 id 표로 id 를 붙여 결과
```

## 결정

- D-1 편집 종류는 `editOperationSchema`(zod discriminatedUnion on `kind`) 하나. 새 편집 = 스키마 + `applyEdit` case(빠뜨리면 never 컴파일 오류) + 서버 `session.edit` 호출(id 표 옮기기는 `updateIds`).
- D-2 뷰어 결과는 바뀐 블록의 위치(anchor)와 내용. 서버는 `BlockIdTable.idAt(anchor)` 로 id(누름틀 순번 포함). 넣은 블록은 updateIds 가 새 id 를 준 뒤 붙는다.
- D-3 누름틀은 블록에 fieldId 를 넣지 않고 위치의 같은 문단 안 순번으로 getFieldList 에서 fieldId.
- D-4 저장하지 않은 편집 수는 EditLog 의 상태 줄 비교(20칸과 따로). AC-12 는 이 값(뷰어 dispose 값은 20칸 상한이라 쓰지 않음).
- D-5 바뀐 블록 표시 = 블록 전체를 쪽마다 감싼 2px 초록 테두리(개인 DS success). 하이라이트를 그리면 지우고, 편집은 다시 그려 하이라이트를 지운다. undo 뒤에는 표시 없음.
- D-6 undo 는 있는 만큼 되돌리고 경고, 없으면 "되돌릴 편집이 없습니다." 오류 결과.
