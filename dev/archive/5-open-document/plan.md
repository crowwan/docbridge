# #5 MCP 서버 ↔ 뷰어 연결과 문서 열기 — 계획

범위: SPEC-001 AC-1, AC-2, AC-3, AC-8, AC-10 + PR #10 리뷰 이월 2건(다음 빈 포트, 정적 파일 경로 decode).

## 설계

```
MCP open_document ─▶ DocumentSession(server/session.ts)
                       │ 확장자·크기 검사, 파일 읽기, 마지막 경로·블록 id 표 기억
                       │ 뷰어 없으면 openBrowser(viewerUrl) 후 연결 대기
                       ▼
                     Bridge(server/bridge.ts) ── request(method, params) ──▶ 뷰어(viewer/main.ts)
                       127.0.0.1, 토큰, 7790~7799           요청 id·타임아웃       rhwp 로 렌더링·블록 추출
                       정적 파일(decode)                    ◀── response(ok/error)
```

- 프로토콜(`src/shared/protocol.ts`): `request {id, method, params}` / `response {id, ok, result | error}`. 메서드는 `load_document` 하나(파일 이름 + base64 바이트 → 쪽 수 + 블록 위치 목록). 결과는 zod 로 읽는다. 오류 문구·타임아웃 상수도 여기에.
- 서버는 블록 위치(kind·구역·문단·표 번호)만 받아 `BlockIdTable` 을 만든다. 새로고침으로 뷰어가 다시 붙으면 같은 파일을 다시 보내고 표는 그대로 둔다(AC-10).
- 뷰어 요청 공용 경로 `session.requestViewer` 가 뷰어 미연결 시 스펙 문구 + 마지막 파일 경로로 오류(AC-8). #6 도구가 이 경로를 쓴다.
- 뷰어 화면: 토큰 없음/거부("docbridge 가 연 탭이 아닙니다"), 문서 오류("문서를 열 수 없습니다" + 이유).

## 정한 값 (스펙 반영)

- 포트: 시작 포트(기본 7790)부터 10개(7790~7799) 시도, 모두 사용 중이면 시작 실패.
- 파일 크기 상한: 50MB.
- 뷰어 요청 타임아웃: 30초. 브라우저를 띄운 뒤 뷰어 연결 대기: 30초.

## 커밋 단위

1. fix: 정적 파일 경로 decode (#5)
2. feat: 7790 사용 중이면 다음 빈 포트 (#5)
3. feat: 서버↔뷰어 요청/응답 프로토콜 (#5)
4. feat: open_document 와 문서 세션 (#5)
5. feat: 뷰어 연결·문서 열기·오류 화면 (#5)
6. test: E2E (#5), docs: 스펙·CLAUDE.md
