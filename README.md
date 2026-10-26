# docbridge

받은 한글(HWP/HWPX) 문서를 **내가 쓰는 Claude 채팅**에서 묻고 말로 고치게 해 주는 로컬 브리지입니다. 문서는 브라우저 뷰어에 원래 모양대로 뜨고, Claude 가 답의 근거로 삼은 부분이 그 화면에 하이라이트됩니다.

```
Claude 채팅 ──stdio── docbridge (내 PC) ──127.0.0.1── 브라우저 뷰어 (@rhwp/core)
```

- 문서는 내 PC 밖으로 나가지 않습니다. 뷰어 서버는 127.0.0.1 에서만 열리고, docbridge 가 연 탭(세션 토큰)만 붙을 수 있습니다.
- Claude 가 읽는 내용(문서 텍스트)은 사용 중인 Claude 채팅으로 전달됩니다.
- 지금은 v0.1 개발 중입니다(읽기: 열기·구조 보기·찾기·하이라이트). 편집과 저장은 다음 단계입니다.

## 설치

Node 24 가 필요합니다.

```bash
git clone https://github.com/crowwan/docbridge.git
cd docbridge
npm ci
npm run build
```

빌드가 끝나면 `dist/server/index.js` 가 docbridge 실행 파일입니다. 아래 등록에는 이 파일의 **절대 경로**를 씁니다 (`pwd` 로 확인).

## Claude 에 등록

### Claude Desktop

1. Claude Desktop 설정 파일을 엽니다: `~/Library/Application Support/Claude/claude_desktop_config.json` (Windows: `%APPDATA%\Claude\claude_desktop_config.json`). 없으면 만듭니다.
2. `mcpServers` 에 docbridge 를 넣습니다.

   ```json
   {
     "mcpServers": {
       "docbridge": {
         "command": "node",
         "args": ["/절대/경로/docbridge/dist/server/index.js"]
       }
     }
   }
   ```

   `node` 를 nvm 등으로 설치했으면 `command` 에 `which node` 결과(절대 경로)를 넣습니다. Claude Desktop 은 셸 설정을 읽지 않아 `node` 를 못 찾을 수 있습니다.
3. Claude Desktop 을 완전히 종료했다가 다시 엽니다. 채팅 입력창의 도구 목록에 docbridge 가 보이면 됩니다.

### Claude Code

```bash
claude mcp add docbridge -- node /절대/경로/docbridge/dist/server/index.js
```

## 사용

채팅에서 이렇게 말하면 됩니다.

> ~/Downloads/공문.hwpx 열어줘

브라우저에 뷰어 탭이 열리고 문서가 뜹니다. 이어서

> 회신 기한이 언제야? 근거도 표시해줘

라고 물으면 Claude 가 문서를 읽고 답하며, 근거 부분이 뷰어에서 하이라이트됩니다.

- 한 번에 문서 하나만 엽니다. 다른 파일을 열면 같은 탭의 문서가 바뀝니다.
- 뷰어 탭을 닫았으면 다시 "열어줘"라고 하면 됩니다.
- 열 수 있는 파일: `.hwp`, `.hwpx` (50MB 까지).

## 설정

| 환경 변수 | 기본값 | 설명 |
|---|---|---|
| `DOCBRIDGE_PORT` | `7790` | 뷰어 서버 시작 포트. 사용 중이면 다음 포트로 넘어가 10개까지 시도합니다 |

Claude Desktop 에서는 `mcpServers.docbridge.env` 에 넣습니다.

## 문제 해결

- **브라우저가 안 열려요**: Claude 의 답에 뷰어 주소(`http://127.0.0.1:7790/?token=…`)가 있습니다. 직접 열면 됩니다.
- **"docbridge 가 연 탭이 아닙니다"**: docbridge 가 다시 시작되면서 토큰이 바뀐 예전 탭입니다. 닫고 다시 "열어줘"라고 하세요.
- **"포트 7790~7799 이 모두 사용 중입니다"**: `DOCBRIDGE_PORT` 로 다른 포트를 정하세요.
- **로그**: docbridge 는 로그를 stderr 로 남깁니다. Claude Desktop 은 `~/Library/Logs/Claude/mcp-server-docbridge.log` 에 모읍니다.

## 개발

개발 명령과 폴더 구조는 [`CLAUDE.md`](CLAUDE.md), 기획과 스펙은 [`docs/`](docs/) 에 있습니다.

## 감사

문서 파싱과 렌더링은 [rhwp](https://github.com/edwardkim/rhwp) (MIT) 의 `@rhwp/core` 를 씁니다.
