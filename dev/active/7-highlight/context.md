# #7 컨텍스트

- 이슈: https://github.com/crowwan/docbridge/issues/7 (부모 #3, 스펙 SPEC-001)
- 기반: #6(PR #12) TextTarget·읽기 도구·프로토콜(메서드 빠뜨리면 컴파일 오류), #5 세션 공용 경로
- 관련 파일: `src/core/{chars,highlight-rects,highlight-targets,block-ids,find-text}.ts`, `src/server/{highlight-tools,session,mcp,reading}.ts`, `src/shared/protocol.ts`, `src/viewer/{main.ts,tokens.css,viewer.css,index.html}`, `tests/{chars,highlight-rects,highlight-targets,highlight-tools}.test.ts`, `e2e/highlight-tool.spec.ts`

## 발견

- 2026-10-26 rhwp `getSelectionRects` 는 빈 문단(범위 안 글자 0)에 사각형을 주지 않는다 → 줄 목록에서 빼면 개수가 맞는다. 여러 문단 범위의 중간 문단 마지막 줄은 단 오른쪽 끝까지 칠한다 → at_end 캐럿으로 오른쪽 보정.
- rhwp 글자 위치는 code point. `getTextRange(sec, para, offset, count)` 의 넷째 인자는 끝이 아니라 개수.
- `getFieldList` 에 `startCharIdx`·`endCharIdx`(값 범위)와 `location.path`(표 칸이면 `[{controlIndex, cellIndex, paraIndex}]`)가 있다. 값이 빈 누름틀의 안내문은 문단 글자가 아니라 글자 배치(run, paraIdx 없음)로만 그려진다.
- `getTableCellBboxes` 는 칸마다 `{cellIdx, pageIndex, x, y, w, h}`. 표 bbox(`getTableBBox`)와 합집합이 같다.
- E2E 는 `DOCBRIDGE_E2E_PORT=7811` 로 돌림(#6 과 병렬).
