# docbridge

받은 한글(HWP/HWPX) 문서를 내가 쓰는 Claude 채팅에서 묻고 말로 고치는 로컬 브리지. 화면은 브라우저 뷰어(@rhwp/core).

## 개발 규칙

개인 프로젝트 공용 규칙(`~/Works/personal/_playbook/PLAYBOOK.md`)을 따른다.

- 기획: `docs/prd.md`, `docs/specs/SPEC-*.md` — 스펙이 동작의 기준. 구현 중 동작이 바뀌면 스펙부터 고친다.
- 작업: GitHub Issues + Projects. 이슈는 approved 스펙에서만 만든다 (`/spec-issues`).
- 브랜치 `<종류>/<이슈번호>-<이름>`, 커밋 `feat: 한글 메시지 (#12)`, PR 로만 머지 (squash).
- 테스트: 스펙 ID 를 테스트 묶음 이름에, AC 내용을 테스트 이름에 한글로.
- 릴리스: `/release v0.x`

## 현재 상태

- 마일스톤: v0.1
- 진행 중 스펙: SPEC-001 연결과 묻기 (approved)
- Projects 보드: #6 (https://github.com/users/crowwan/projects/6)

## 스택

- Web (TS). 로컬 MCP 서버(stdio) + 127.0.0.1 WebSocket + 브라우저 뷰어(@rhwp/core 직접 사용) — 세부는 첫 스펙·ADR 에서 확정
- 조사 자료: `docs/research/`

## 실행

```bash
# 빌드 / 테스트 / 실행 명령
```

## 폴더 구조

```
```
