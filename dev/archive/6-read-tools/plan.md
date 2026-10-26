# #6 문서 구조 읽기 도구 get_outline · read_blocks · find_text — 계획

범위: SPEC-001 AC-4, AC-5, AC-6, AC-9 + PR #10·#11 리뷰 이월 4건.

## 설계

```
MCP get_outline / read_blocks / find_text
  └ server/read-tools.ts ── session.requestViewer('get_blocks' | 'find_text') ──▶ 뷰어(viewer/main.ts)
       │  id 표로 블록 위치 → id                                                 열 때 뽑은 블록(extractBlocks)을 들고 있다
       │  server/reading.ts (순수): 개요 항목·앞 40자·500블록 자르기,             find: core/find-text.ts (순수)
       │                            read 선택(ids·쪽)·20,000자 자르기
       ▼
     JSON 결과 (잘리면 more.message + more.next = 다시 부를 인자)
```

- 뷰어 메서드: `load_document`(있음), `get_blocks`(전체 블록 전문), `find_text`(query → 일치 위치 + 앞뒤 20자).
- 블록 스키마(zod)를 `core/block-schema.ts` 하나에 두고 `Block`·`BlockPosition` 은 `z.infer`. 서버는 뷰어 결과를 이 스키마로 읽는다.
- 요청 메시지 스키마는 메서드별 판별 유니언. 뷰어는 모르는 메서드도 id 가 있으면 오류로 응답(30초 타임아웃 방지).
- 누름틀에 쪽(`page`) 추가.

## 정한 형식 (스펙 도구 표에 반영)

- 범위 = `{ id, start, end }`(문단), `{ id, row, col, start, end }`(표 칸). 글자 위치는 블록(칸) 텍스트 기준 0부터, end 는 포함하지 않음. 칸 텍스트는 칸 안 문단을 `\n` 으로 잇는다. → #7 highlight 입력 그대로.
- find_text 는 문단·표 칸에서 찾는다. 누름틀 값은 그 누름틀이 든 문단·칸 텍스트에 들어 있어 따로 찾지 않는다.
- 잘림: `more: { message, next }`. get_outline `next = { from: "b501" }`, read_blocks `next = { ids: [...] }` 또는 `{ fromPage, toPage, from }`.
- 한 블록이 혼자 20,000자를 넘으면 그 블록을 잘라 보내고 `truncated: true`.

## 이월 4건

1. 번호 글자 배치(getPageTextLayout)는 번호·개요 문단이 있는 쪽만 읽는다.
2. getSectionStarts: 조사 결과 SectionDef 표식 기준이라 물리 구역 시작과 다를 수 있음(breakAtCursor section 뒤 [0,1], 구역 수 1) → 쓰지 않고 재현 테스트로 남긴다.
3. 요청 스키마 판별 유니언.
4. BlockPosition 한 곳(z.infer).

## 커밋 단위

1. refactor: 블록 스키마 zod 하나로, BlockPosition z.infer (#6)
2. refactor: 요청 스키마를 메서드별 판별 유니언으로 (#6)
3. refactor: 번호 글자 배치 지연 계산, 구역 시작 계산 근거 테스트 (#6)
4. feat: 개요·읽기·찾기 순수 변환 (#6)
5. feat: get_outline · read_blocks · find_text 도구 (#6)
6. test: fixture 별 get_outline 기대 JSON (#6), E2E
7. docs: 스펙·CLAUDE.md·ADR
