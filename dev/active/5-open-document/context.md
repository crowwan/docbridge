# #5 컨텍스트

- 이슈: https://github.com/crowwan/docbridge/issues/5 (부모 #3, 스펙 SPEC-001)
- 기반: #4(PR #10) — `src/server/bridge.ts`(HTTP·WS·토큰), `src/core/blocks.ts`(블록 추출), `src/core/block-ids.ts`(id 표)
- 관련 파일: `src/shared/protocol.ts`, `src/server/{bridge,session,mcp,index}.ts`, `src/viewer/main.ts`, `tests/server.test.ts`, `e2e/`
- 테스트: 단위·통합은 가짜 뷰어(ws 클라이언트) + InMemoryTransport, 타임아웃은 가짜 타이머(setTimeout 만). E2E 는 실제 빌드 뷰어 + 세션(브라우저 여는 함수 = page.goto).
- 결정 메모는 진행하며 아래에 추가.

## 결정·발견
