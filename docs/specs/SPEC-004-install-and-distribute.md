---
id: SPEC-004
title: 설치와 배포
status: draft          # draft | approved | in-progress | done | dropped
milestone: v0.2
issue:
prototype:
updated: 2026-10-27
---

# SPEC-004 설치와 배포

## 배경과 목표

지금 docbridge 는 내 Mac 에서만 돈다. 레포를 받아 `npm ci && npm run build` 를 하고, `claude_desktop_config.json` 에 Node 절대 경로와 `dist/server/index.js` 경로를 손으로 적어야 한다. PRD 의 넓은 사용자(한글을 가끔 받아 고치는 비개발자)는 Node 도 터미널도 없다.

이 스펙이 끝나면:
- **Claude Desktop 사용자**는 GitHub Releases 에서 `docbridge.mcpb` 를 받아 더블클릭(또는 설정 › 확장에 끌어다 놓기)하면 끝난다. Node 설치·설정 파일 편집이 없다.
- **Claude Code 사용자**는 `claude mcp add docbridge -- npx -y @crowwan/docbridge` 한 줄로 붙인다.
- 맥과 윈도우에서 같은 파일로 돈다.
- 태그를 올리면 CI 가 `.mcpb` 와 npm 패키지를 만들어 올린다.

## 동작 정의

### 배포물 두 가지

| 배포물 | 대상 | 들어 있는 것 | 실행 |
|---|---|---|---|
| `docbridge-<버전>.mcpb` | Claude Desktop(맥·윈도우) | `manifest.json`, 서버 번들(의존성 포함 JS 한 파일), 뷰어(`viewer/`: HTML·JS·CSS·rhwp WASM), 아이콘, `LICENSE` | Claude Desktop 에 들어 있는 Node 로 `${__dirname}/server/index.js` |
| npm `@crowwan/docbridge` | Claude Code, Node 가 있는 사람 | 같은 서버 번들과 뷰어, `bin: docbridge` | `npx -y @crowwan/docbridge` |

- 두 배포물은 **같은 빌드 결과**를 담는다. 서버는 의존성(`@modelcontextprotocol/sdk`·`ws`·`zod`·`@rhwp/core`)을 한 파일로 묶어 `node_modules` 없이 돈다. rhwp WASM 은 번들 옆 파일로 둔다.
- 네이티브 모듈이 없으므로 플랫폼별 파일을 따로 만들지 않는다.

### manifest.json

- `manifest_version` 은 mcpb 현재 버전(0.3), `server.type: "node"`, `entry_point: "server/index.js"`, `mcp_config: { command: "node", args: ["${__dirname}/server/index.js"] }`.
- `name: docbridge`, `display_name: docbridge`, `version` 은 package.json 과 같다(빌드 때 채움, 손으로 두 군데 고치지 않는다).
- `description`: "받은 한글(HWP/HWPX) 문서를 Claude 채팅에서 묻고 고칩니다. 문서는 브라우저에 띄워 보여 줍니다."
- `tools`: MCP 도구 16개 이름과 한 줄 설명(설치 화면에 보인다). 도구 목록은 `src/server/mcp.ts` 에서 뽑아 만들고 손으로 적지 않는다.
- `compatibility.platforms: ["darwin", "win32"]`. 리눅스는 Claude Desktop 이 없어 넣지 않는다(npm 으로는 된다).
- `user_config` 는 두지 않는다. 포트는 기본 7790~7799 자동 선택으로 충분하다.

### 브라우저 열기

- 지금은 macOS `open` 만 쓴다. 플랫폼별로 맥 `open`, 윈도우 `cmd /c start "" <주소>`, 리눅스 `xdg-open` 을 쓴다.
- 열지 못하면 지금처럼 stderr 에 주소를 남기고, `open_document`·`create_document` 결과의 `viewerUrl` 로 Claude 가 사용자에게 주소를 알려 줄 수 있다(기존 동작).

### 릴리스 흐름

1. `/release v0.x` 가 버전을 올리고 태그(`v0.x.y`)를 민다.
2. 태그 CI 가 빌드 → 테스트 → `.mcpb` 만들기(`mcpb pack`) → GitHub Release 에 `.mcpb` 첨부 → `npm publish --access public`.
3. Release 본문에 설치 방법 두 줄(Desktop·Code)과 CHANGELOG 해당 부분.

### README 설치 안내

- 맨 위에 "설치" 절: Desktop(`.mcpb` 받기 → 더블클릭), Code(`claude mcp add …`) 두 가지. 개발용 설치(레포 받아 빌드)는 아래 "개발" 절로 옮긴다.
- 데모 영상 정지 화면 한 장을 함께 둔다.

### 예외와 경계 상황

- **Claude Desktop 에 든 Node 버전이 낮을 때**: 지금 `engines` 는 Node 24 이상이다. 번들은 Desktop 에 든 Node 버전에서 돌아야 한다(기술 검증에서 버전 확인 후 번들 target 과 `compatibility.runtimes.node` 를 정한다).
- **포트 7790~7799 가 모두 쓰일 때**: 기존 동작대로 오류. 설치판도 같다.
- **이전 수동 설정과 겹칠 때**: `claude_desktop_config.json` 에 손으로 넣은 docbridge 와 확장을 같이 켜면 서버가 둘 뜬다(포트는 자동으로 다르게 잡힌다). README 에 "수동 설정은 지우세요" 한 줄.
- **윈도우 경로**: 저장·새 문서 경로 규칙(`~`, 절대 경로)이 윈도우 경로(`C:\…`)에서도 맞게 돈다.

## 수용 기준

- [ ] AC-1 `npm run pack` 이 `dist/docbridge-<버전>.mcpb` 를 만들고, `mcpb validate`(또는 manifest 스키마 검사)를 통과한다 (자동)
- [ ] AC-2 서버 번들은 `node_modules` 없는 빈 폴더에 풀어도 `node server/index.js` 로 뜨고, MCP 클라이언트로 `open_document` → `read_blocks` → `save_document` 가 된다 (자동)
- [ ] AC-3 manifest 의 `version` 이 package.json 과 같고, `tools` 가 실제 등록 도구 16개와 같다 (자동)
- [ ] AC-4 브라우저 열기가 플랫폼별 명령(맥 `open`, 윈도우 `cmd /c start`, 리눅스 `xdg-open`)을 고른다 (자동)
- [ ] AC-5 경로 규칙(`~`, 절대 경로 판정, 기본 저장 이름)이 윈도우 경로에서도 맞다 (자동)
- [ ] AC-6 npm 패키지(`npm pack` 결과)를 빈 폴더에서 `npx` 로 실행하면 서버가 뜬다 (자동)
- [ ] AC-7 태그를 올리면 CI 가 Release 에 `.mcpb` 를 붙이고 npm 에 배포한다 (수동 QA — 첫 릴리스에서 확인)
- [ ] AC-8 맥 Claude Desktop 에서 `.mcpb` 를 더블클릭해 설치하고, 수동 설정 없이 "공문.hwpx 열어줘" → 하이라이트 → 저장이 된다 (수동 QA)
- [ ] AC-9 윈도우 Claude Desktop 에서 AC-8 과 같은 흐름이 되고, 저장한 파일이 한글에서 열린다 (수동 QA — 윈도우 기기 생길 때)
- [ ] AC-10 Claude Code 에서 `claude mcp add docbridge -- npx -y @crowwan/docbridge` 로 붙여 같은 흐름이 된다 (수동 QA)

## 범위 밖

- claude.ai 웹·모바일용 원격 커넥터 (PRD — 문서가 서버를 거침)
- Anthropic 확장 디렉터리 등록, MCP Registry 등록 — 첫 배포 뒤 따로 결정
- 자동 업데이트 (새 `.mcpb` 를 다시 설치하는 방식으로 충분)
- 코드 서명(`mcpb sign`) — 경고가 문제 되면 그때
- 리눅스 Claude Desktop

## 기술 메모

- mcpb: Node 는 맥·윈도우용 Claude 에 들어 있다(mcpb README). `npx @anthropic-ai/mcpb init` 으로 manifest 초안, `mcpb pack <폴더>` 로 묶는다. 의존성은 번들 안에 있어야 한다 → 서버를 esbuild 로 한 파일로 묶으면 `node_modules` 를 통째로 넣지 않아도 된다.
- 서버는 `dist/server/index.js` 기준 `../viewer/` 를 연다(`src/server/index.ts`). 번들 폴더도 `server/`·`viewer/` 를 나란히 둬서 이 규칙을 지킨다.
- `@rhwp/core` 는 서버에서도 쓴다(저장 검증 등). WASM 로딩 경로가 번들 후에도 맞는지 AC-2 로 확인한다.
- 크기: 지금 `dist` 12MB(대부분 WASM 과 뷰어). `.mcpb` 는 zip 이라 더 작다.
- npm 이름 `docbridge` 는 다른 CLI 가 쓰고 있어 `@crowwan/docbridge` 로 한다. package.json `"private": true` 를 빼고 `files`·`bin` 을 정한다.
- 라이선스: 레포에 `LICENSE` 가 없다. rhwp 가 MIT 이므로 MIT 로 하고 `LICENSE` 를 넣는다(PRD 열린 질문 해소).
- npm 배포 토큰은 레포 시크릿 `NPM_TOKEN`(사용자가 넣는다). 공개 레포라 Actions 분 제한은 없다.

## 열린 질문

- Claude Desktop 에 든 Node 버전과 번들 target — 결정: 기술 검증 후
- 아이콘 — 결정: 구현 중 (없으면 기본 아이콘)
- Cowork 에서 확장이 그대로 보이는지 — 결정: v0.2 사용 후

## 변경 이력

| 날짜 | 내용 |
|---|---|
| 2026-10-27 | 초안 |
