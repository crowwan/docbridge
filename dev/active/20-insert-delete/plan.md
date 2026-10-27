# #20 문단 넣기·지우기 — 계획

범위: SPEC-002 AC-2(insert_paragraph), AC-3(delete_blocks). #19 편집 공용 경로(session.edit → 뷰어 DocumentEditor.edit → applyEdit) 위에 편집 종류 둘을 더한다.

## 설계

```
insert_paragraph(before|after, text)               delete_blocks(ids)
  server/edit-tools.ts                               server/edit-tools.ts
   기준 id → anchor, at = before ? p : p+1            ids → anchor, planDeletion(대상, id 표 위치)  ← 거부(누름틀·구역 첫 문단)는 뷰어에 보내기 전에
   session.edit(이름, {kind:'insert_paragraph'},      session.edit(이름, {kind:'delete_blocks', targets},
     ids => ids.paragraphInserted(sec, at))              ids => 계획대로 tableDeleted / paragraphDeleted(뒤에서부터))
  뷰어 applyEdit                                      뷰어 applyEdit
   insertParagraphNear(edits.ts)                       planDeletion(대상, 뷰어 블록 위치) — 서버와 같은 함수
   → paragraphs:[새 문단], 위치 옮김(넣은 자리부터 +1)     → deleteTableControl / deleteParagraph, 위치 옮김(지운 문단 없앰, 뒤는 당김)
```

- `EditApplied.changes`(ParagraphChanges) → `relocate(changes)`: 편집 전 문단 위치 → 편집 뒤 위치(지운 문단 undefined). DocumentEditor 가 "블록으로 남길 빈 문단" 표를 옮길 때, 서버가 id 표를 옮길 때 같은 정보를 쓴다(#21 옮기기도 같은 자리).

## 결정

- D-1 줄바꿈: 스펙에 없어 거부(문단마다 부름). 빈 text 는 빈 문단(ADR 002 에서 검증한 경로, 빈 문단 블록으로 남음).
- D-2 표 블록 지우기: rhwp `deleteParagraph` 는 표 문단을 표째 지우고, `deleteTableControl` 은 표만 지우고 빈 문단을 남긴다(확인). 그 문단에 다른 블록이 없으면 문단째, 있으면 표만.
- D-3 문단 블록 지우기는 문단째(든 표·누름틀도). 결과 deleted 에 같이 지운 id.
- D-4 구역 첫 문단 지우기 거부: rhwp 가 secd·cold 컨트롤까지 지운다(확인, HWPX 저장 때 다시 생김). 그래서 구역이 비는 삭제는 생기지 않는다.
- D-5 ~~지우기 계획(planDeletion)을 서버·뷰어가 같은 함수로 계산~~ → PR #29 리뷰: 뷰어만 정하고 실제로 지운 문단·표·넣은 자리(ParagraphChanges)를 결과로 돌려주며 서버 id 표는 그것으로 옮김. 서버는 assertDeletable(누름틀 블록·구역 첫 문단)만. 문단째 지울 문단의 블록이 아닌 개체는 getControls 종류로 거부(보이지 않는 인라인 컨트롤 허용).
- D-7 rhwp deleteTableControl 은 같은 문단 누름틀을 잃음 → 누름틀이 든 문단의 표만 지우기 거부.
- D-6 block-ids.ts: 기존 paragraphInserted·paragraphDeleted 를 쓰고, 새로 anchorsAt(같은 문단 id·위치)·tableDeleted(표만 지움, 뒤 표 컨트롤 번호 당김)만 더한다.
