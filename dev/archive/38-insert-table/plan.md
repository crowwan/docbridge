# #38 표 만들기 insert_table (SPEC-003 AC-6)

## 목표

`insert_table(before|after, rows, cols, cells?, header?)` 를 SPEC-002 편집 공용 경로의 편집 종류로 더한다. "문단 넣기 + 표 넣기" 한 편집(undo 한 번).

## 방식

- core `edit-operations.ts`: `insert_table` 스키마 + applyEdit case. 기준 블록이 든 본문 문단 앞·뒤에 `insertTableParagraph`(#35 프로토타입, ADR 003 결정 5~8)
- `paragraph-changes.ts`: `inserted` 항목에 `tableControlIndex`(선택) — 넣은 문단이 표 문단이면 새 id 를 문단 글자가 아니라 표 블록에 준다. relocate 는 그대로(문단 하나 넣기)
- `document-editor.ts`: 표 문단은 빈 문단 블록으로 남기지 않는다(글자 없는 표 문단에 빈 문단 블록이 생기지 않게)
- `block-ids.ts` `paragraphInserted(section, index, part)`, `session.ts` 가 part 를 넘김
- 서버 `edit-tools.ts` `insertTable`: 크기·cells 검사는 뷰어에 보내기 전에(assertTableSpec 공용), 결과 `{ inserted, cells, changed, warnings? }`
- `mcp.ts` 도구 등록

## 결정

- D-1 크기 거부는 서버에서 먼저(뷰어 요청 없음) + core 에서도(테스트 뷰어·스크립트 직접 호출). 문구는 프로토타입 그대로
- D-2 결과 `cells` = 칸 수(rows×cols, 스펙 "칸 수")
- D-3 표 안 표: 기준이 표 블록이어도 그 표가 든 본문 문단 앞·뒤에 넣으므로 칸 안에는 만들어지지 않는다(입력에 칸 주소가 없다)

## 위험

- #37 이 스타일 코드를 `src/core/styles.ts` 로 옮길 수 있다 → rebase 때 `resetToStyle` import 맞춤
