# #5 컨텍스트

- 이슈: https://github.com/crowwan/docbridge/issues/5 (부모 #3, 스펙 SPEC-001)
- 기반: #4(PR #10) — `src/server/bridge.ts`(HTTP·WS·토큰), `src/core/blocks.ts`(블록 추출), `src/core/block-ids.ts`(id 표)
- 관련 파일: `src/shared/protocol.ts`, `src/server/{bridge,session,mcp,index}.ts`, `src/viewer/main.ts`, `tests/server.test.ts`, `e2e/`
- 테스트: 단위·통합은 가짜 뷰어(ws 클라이언트) + InMemoryTransport, 타임아웃은 가짜 타이머(setTimeout 만). E2E 는 실제 빌드 뷰어 + 세션(브라우저 여는 함수 = page.goto).
- 결정 메모는 진행하며 아래에 추가.

## 결정·발견
- 서버는 블록 위치(kind·구역·문단·표 번호)만 받는다. `BlockIdTable` 입력을 `BlockPosition` 으로 넓혔다(Block 도 그대로 들어감).
- 요청은 "마지막에 붙은 뷰어"가 받는다. 그 뷰어가 끊기면 기다리던 요청은 미연결 오류.
- 새로고침: bridge 'connected' 이벤트 → 세션이 마지막 파일을 다시 읽어 보내고 id 표는 유지. open() 중에는 다시 띄우지 않는다(브라우저 띄우기와 겹침 방지). `session.ready()` 로 다시 띄우기 완료를 기다리고, `requestViewer` 도 먼저 기다린다.
- 기술 검증용 ping 도구는 걷어냈다. stdio 통합 테스트는 stderr 의 "뷰어 주소:" 로그에서 주소를 읽어 가짜 뷰어를 붙인다.
- 인코딩된 `..` 은 `normalize('/../x')` 가 `/x` 로 접어 폴더 밖으로 못 나간다(따로 막을 줄이 없어 테스트하지 않음).
- rhwp 손상 파일 오류 문구 예: "유효하지 않은 파일: 지원하지 않는 포맷입니다: 알 수 없는 파일 형식. 오류코드: UNSUPPORTED_FILE_FORMAT. …"
