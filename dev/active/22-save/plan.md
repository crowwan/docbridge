# #22 저장: save_document 와 저장 전 검증 — 계획

- 이슈: https://github.com/crowwan/docbridge/issues/22 (부모 #17, 스펙 SPEC-002 AC-9·10·11·14)
- 근거: ADR 002 "저장", "열린 질문 결론"(마지막 파일·새로고침)

## 구성

1. 뷰어(rhwp): 새 요청 `export_hwpx` — `exportVerifiedHwpx` 로 내보내 다시 열어 비교. 같으면 base64 바이트 + 손실 보고 + 지금 블록 위치, 다르면 달라진 블록 위치·다시 열기 오류(바이트 없음). 50MB 를 넘으면 오류
2. 뷰어: 새 요청 `edit_state` — 서버가 준 저장 안 한 편집 수와 상태 줄 파일 이름. `beforeunload` 확인 창(저장 안 한 편집이 있을 때)
3. 서버 `save-path.ts`: 경로 정하기(기본 이름·번호, 상대·~/, 확장자, 원본·기존 파일 덮어쓰기), 원자적 쓰기(임시 파일 → rename)
4. 서버 `save-tool.ts`: export_hwpx → 검증 실패면 블록 id 와 오류 → 쓰기 → 세션에 저장 기록(마지막 파일, 기준 id 표, 편집 수 0) → 뷰어에 edit_state
5. 세션: 원본 경로(sourcePath)·기준 id 표(savedIds)·편집 수(editCount/dirty, #19 와 같은 이름)·알림(notices). 새로고침 때 기준 표로 되돌리고 사라진 편집 수를 다음 도구 결과에
6. mcp.ts: `save_document` 등록, 도구 결과 뒤에 알림 붙이기

## 테스트 (묶음 `SPEC-002 …`)

- AC-9 경로 규칙(단위 + 도구), AC-10 검증 실패(다시 열기 주입), AC-11 저장 후 다시 열기, AC-14 새로고침(rhwp 테스트 뷰어), 쓰기 실패 상태 유지, 손실 경고, 크기 상한
- E2E: beforeunload 확인 창, 서버가 내준 뷰어로 저장
