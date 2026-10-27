# #37 스타일 — 계획

범위: SPEC-003 AC-3(list_styles), AC-4(insert_paragraph style), AC-5(set_style). #35 프로토타입(create-document.ts 스타일 부분)을 정식 코드(`src/core/styles.ts`)로 옮기고 SPEC-002 편집 공용 경로에 편집 종류를 더한다.

## 설계

```
list_styles()                     insert_paragraph(…, style)                set_style(ids, style)
 server/style-tools.ts             server/edit-tools.ts                      server/style-tools.ts
  requestViewer('list_styles')      operation.style 실어 session.edit          assertStylable(문단 블록만) → session.edit
 뷰어                               뷰어 applyEdit insert_paragraph            뷰어 applyEdit set_style
  paragraphStyles(doc)               styleIdByName → insertParagraphNear       styleIdByName → 대상마다 applyParagraphStyle
                                     → resetToStyle(문단·글자 모두 스타일)       (바뀐 블록 = 대상 + 번호 바뀐 문단, document-editor)
```

## 결정

- D-1 스타일 코드 위치: `src/core/styles.ts` 로 옮긴다(paragraphStyles·styleIdByName·applyParagraphStyle·resetToStyle·ensureTitleStyle·TITLE_STYLE·NORMAL_STYLE). create-document.ts 는 표·양식 비우기만 남고 styles.ts 를 import. 테스트도 `tests/styles.test.ts` 로(묶음 `SPEC-003 스타일 …`, "(기술 검증)" 뗌).
- D-2 스타일 이름 → id 는 뷰어에서(문서를 가진 쪽). 없는 스타일은 뷰어가 편집 전에 던지고, 공용 경로가 스냅샷으로 되돌려 기록에 남지 않는다.
- D-3 insert_paragraph + style: 새 문단은 스타일 모양 그대로(문단·글자 모두, resetToStyle). 기준 문단의 직접 글자 서식(끝 글자 굵게 등)을 물려받지 않는다 — insert_table 의 새 문단과 같은 규칙. set_style 은 스펙대로 직접 글자 서식을 남긴다(받은 문서의 굵게를 지우지 않음). → 스펙 "스타일 적용" 에 반영.
- D-4 set_style 거부: 문단 블록이 아닌 id(표·누름틀)는 서버가 id 표 위치(part)로 뷰어에 보내기 전에 거부, 뷰어도 같은 함수로 확인. 여러 id 는 편집 하나(undo 한 번).
- D-5 list_styles 결과: `{ styles: [{ name, englishName, outline, outlineLevel? }] }`. id 는 내보내지 않는다(이름으로 고른다). create_document(#36) 도 같은 항목 함수(styleItems)를 쓴다.
- D-6 set_style 결과: `{ changed: [{ id, number?, text }] }` — 대상과 번호가 바뀐 문단. 번호 항목은 move_blocks 와 같은 함수.
