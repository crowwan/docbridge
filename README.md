# docbridge

받은 한글(HWP/HWPX) 문서를 **내가 쓰는 Claude 채팅**에서 묻고 말로 고치게 해 주는 로컬 브리지입니다. 문서는 브라우저 뷰어에 원래 모양대로 뜨고, Claude 가 답의 근거로 삼은 부분이 그 화면에 하이라이트됩니다.

```
Claude 채팅 ──stdio── docbridge (내 PC) ──127.0.0.1── 브라우저 뷰어 (@rhwp/core)
```

- 문서는 내 PC 밖으로 나가지 않습니다. 뷰어 서버는 127.0.0.1 에서만 열리고, docbridge 가 연 탭(세션 토큰)만 붙을 수 있습니다.
- Claude 가 읽는 내용(문서 텍스트)은 사용 중인 Claude 채팅으로 전달됩니다.
- 지금은 v0.1 개발 중입니다(읽기: 열기·구조 보기·찾기·하이라이트, 고치기·저장). 새 문서 만들기(v0.2)를 만드는 중입니다.

## 설치

### Claude Desktop (맥·윈도우)

1. [Releases](https://github.com/crowwan/docbridge/releases/latest) 에서 `docbridge-<버전>.mcpb` 를 받습니다.
2. 받은 파일을 더블클릭하거나, Claude Desktop 의 **설정 › 확장** 화면에 끌어다 놓고 **설치**를 누릅니다.
3. 채팅 입력창의 도구 목록에 docbridge 가 보이면 됩니다. Node 설치나 설정 파일 편집은 필요 없습니다.

- 예전에 `claude_desktop_config.json` 에 docbridge 를 손으로 넣었다면 그 항목을 지운 뒤 **Claude Desktop 을 완전히 종료했다가 다시 열고** 설치하세요. 둘 다 켜 두면 docbridge 가 두 번 뜹니다. 지우기만 하면 Desktop 이 이미 읽어 둔 옛 설정이 남아, 같은 이름 확장을 옛 명령(손으로 넣은 `node` 경로)으로 띄워 시작에 실패합니다.
- 새 버전은 새 `.mcpb` 를 받아 같은 방법으로 다시 설치합니다.

![docbridge 데모: 채팅에서 회신 기한을 묻자 뷰어의 그 부분이 하이라이트된 화면](https://raw.githubusercontent.com/crowwan/docbridge/804ba0067831d622a3454b679cde935e2f8088c2/pr/48/02-highlight.png)

<sub>데모 화면. 왼쪽 채팅은 녹화용으로 꾸민 화면이고, 오른쪽이 실제 docbridge 뷰어입니다.</sub>

Claude Code 에서 쓰거나 직접 빌드하려면 아래 [개발·Claude Code](#개발claude-code) 를 보세요.

## 사용

채팅에서 이렇게 말하면 됩니다.

> ~/Downloads/공문.hwpx 열어줘

브라우저에 뷰어 탭이 열리고 문서가 뜹니다. 이어서

> 회신 기한이 언제야? 근거도 표시해줘

라고 물으면 Claude 가 문서를 읽고 답하며, 근거 부분이 뷰어에서 하이라이트됩니다.

> 회신 기한을 11월 7일로 바꿔줘

라고 하면 바로 고치고, 뷰어에서 바뀐 블록에 초록 테두리가 남습니다. 표 칸·누름틀 값도 같은 방법으로 고칩니다. 잘못 고쳤으면 "되돌려줘"라고 하면 됩니다(최근 것부터 20단계까지).

- 문서를 여러 개 열 수 있습니다(8개까지). 문서마다 브라우저 탭이 하나씩 열리고, 탭 제목은 파일 이름, 도구 막대에는 Claude 가 부르는 문서 이름(`d1`, `d2` …)이 보입니다. "d2 에 넣어줘", "공고문과 신청서를 비교해줘"처럼 문서를 골라 말하면 되고, 말하지 않으면 마지막으로 다룬 문서입니다.
- 보지 않는 탭에 하이라이트나 편집이 생기면 탭 제목 앞에 `●` 가 붙습니다. 그 탭을 보면 지워집니다.
- 이미 열린 파일을 다시 열면 같은 탭에 파일을 다시 읽어 띄웁니다. 그 문서에서 고친 내용을 저장하지 않았으면 그 편집은 버려지고, Claude 가 버린 편집 수를 알려줍니다.
- "d1 닫아줘"라고 하면 그 문서를 닫습니다. 저장하지 않은 편집이 있으면 Claude 가 먼저 물어봅니다. 뷰어 탭을 직접 닫아도 그 문서는 닫히고, Claude 의 다음 답에 알려줍니다. 닫은 문서는 다시 "열어줘"라고 하면 됩니다.
- 열 수 있는 파일: `.hwp`, `.hwpx` (50MB 까지).

### 저장

> 저장해줘

- 항상 HWPX 로 저장합니다(원본이 `.hwp` 여도). 경로를 말하지 않으면 원본 옆에 `<이름>-수정.hwpx`(이미 있으면 `-수정-2` …)로 저장합니다.
- 원본과 이미 있는 파일은 덮어쓰지 않습니다. "원본에 덮어써줘"처럼 분명히 말해야 덮어쓰고, `.hwp` 원본은 덮어쓸 수 없습니다.
- 경로를 말할 때 상대 경로는 원본 폴더 기준입니다("보낼 것/회신.hwpx"). `~/` 도 됩니다.
- 저장 전에 저장할 파일을 다시 열어 글자가 같은지 확인합니다. 다르면 파일을 쓰지 않고 어느 블록이 다른지 알려줍니다.
- 저장하면 그 파일이 "마지막 파일"이 됩니다. 뷰어를 새로고침하면 이 파일을 다시 띄웁니다.
- **저장하지 않은 편집은 뷰어를 새로고침하거나 탭을 닫으면 사라집니다.** 그럴 때 브라우저가 확인 창을 띄웁니다. 새로고침했다면 Claude 의 다음 답에 사라진 편집 수가 붙습니다.

### 새 문서 만들기

> DocBridge 도입 제안서 초안을 ~/Downloads/제안서.hwpx 로 만들어줘
>
> ~/양식/보고서.hwpx 양식으로 ~/Downloads/11월 보고.hwpx 를 만들어줘

- 빈 A4 문서(또는 고른 양식)가 뷰어에 뜨고, Claude 가 제목·본문을 채웁니다. 양식을 주면 양식의 스타일·쪽 설정·머리말·꼬리말은 그대로 쓰고 본문(표·그림 포함)은 비웁니다. 본문까지 남기려면 "내용은 그대로 두고"라고 말하세요. 양식 파일은 바뀌지 않습니다.
- 저장할 경로와 양식 경로는 `~/…` 나 `/…` 처럼 전체 경로로 말해 주세요. 이미 있는 파일 자리에는 만들지 않습니다. 새 문서도 새 탭에 열리고, 열려 있던 문서는 그대로입니다. 저장하지 않은 새 문서는 닫을 때 Claude 가 먼저 물어봅니다.
- 만든 문서는 아직 파일이 없습니다. "저장해줘" 하면 처음 말한 경로에 저장하고, 그 뒤로는 받은 문서처럼 다룹니다(다음 저장은 `<이름>-수정.hwpx`).
- **한 번도 저장하지 않은 새 문서는 뷰어를 새로고침하거나 탭을 닫으면 사라집니다.** 편집이 없어도 브라우저가 확인 창을 띄우고, 새로고침했다면 Claude 의 다음 답에 새 문서가 사라졌다고 붙습니다.

## 설정

| 환경 변수 | 기본값 | 설명 |
|---|---|---|
| `DOCBRIDGE_PORT` | `7790` | 뷰어 서버 시작 포트. 사용 중이면 다음 포트로 넘어가 10개까지 시도합니다 |
| `DOCBRIDGE_FONT_DIRS` | (없음) | PDF 로 내보낼 때 시스템 글꼴 폴더와 함께 훑을 글꼴 폴더(맥·리눅스 `:`, 윈도우 `;` 로 여럿). 설치하지 않은 글꼴 폴더를 더하거나 시험할 때 씁니다. **절대 경로**로 적으세요(Claude Desktop 에서는 작업 폴더가 정해져 있지 않음). 없는 폴더는 건너뛰고, 하위 폴더는 3단계까지, 넣지 말라고 표시된 글꼴은 쓰지 않습니다. 큰 폴더를 주면 처음 내보낼 때 훑는 시간이 깁니다 |

`.mcpb` 확장은 설정 없이 기본값으로 돕니다. 바꿔야 하면 [손으로 등록](#claude-desktop-에-빌드-결과를-손으로-등록)한 설정의 `mcpServers.docbridge.env` 에 넣습니다.

## 문제 해결

- **설치 후 "docbridge 커넥터를 시작할 수 없습니다"**: 로그 `~/Library/Logs/Claude/mcp-server-docbridge.log` 에 "Node.js server requires a resolvable entry point" 가 보이면 예전 수동 설정이 Desktop 에 남은 것입니다. `claude_desktop_config.json` 의 docbridge 항목을 지우고 Claude Desktop 을 완전히 종료했다가 다시 여세요.
- **브라우저가 안 열려요**: Claude 의 답에 뷰어 주소(`http://127.0.0.1:7790/?token=…`)가 있습니다. 직접 열면 됩니다.
- **"docbridge 가 연 탭이 아닙니다"**: docbridge 가 다시 시작되면서 토큰이 바뀐 예전 탭입니다. 닫고 다시 "열어줘"라고 하세요.
- **"포트 7790~7799 이 모두 사용 중입니다"**: `DOCBRIDGE_PORT` 로 다른 포트를 정하세요.
- **"저장하지 못했습니다: … EACCES"**: 그 폴더에 쓸 권한이 없습니다. 다른 폴더(예: `~/Downloads/회신.hwpx`)로 저장해 달라고 하세요. 디스크가 가득 차도(ENOSPC) 같은 문구가 나옵니다. 문서는 열린 그대로라 다시 저장하면 됩니다.
- **"저장 전 검증에 실패해 파일을 쓰지 않았습니다"**: docbridge 가 쓰는 한글 엔진(rhwp)이 지금 문서를 HWPX 로 그대로 옮기지 못했습니다. 알려준 블록의 편집을 되돌리거나 다르게 고쳐 다시 저장해 보세요. 반복되면 문서와 함께 이슈로 알려 주세요.
- **"저장할 문서가 너무 큽니다"**: 50MB 를 넘는 문서는 아직 저장하지 못합니다.
- **새로고침했더니 고친 내용이 사라졌어요**: 저장하지 않은 편집은 뷰어 메모리에만 있어서 새로고침하면 사라집니다(마지막으로 저장한 파일로 돌아갑니다). 채팅에서 다시 고쳐 달라고 하세요.
- **로그**: docbridge 는 로그를 stderr 로 남깁니다. Claude Desktop 은 `~/Library/Logs/Claude/mcp-server-docbridge.log` 에 모읍니다.

## 개발·Claude Code

레포를 받아 빌드해 등록합니다. Node 24 가 필요합니다.

```bash
git clone https://github.com/crowwan/docbridge.git
cd docbridge
npm ci
npm run build
```

빌드가 끝나면 `dist/server/index.js` 가 docbridge 실행 파일입니다. 아래 등록에는 이 파일의 **절대 경로**를 씁니다 (`pwd` 로 확인).

### Claude Code

```bash
claude mcp add docbridge -s user -- node /절대/경로/docbridge/dist/server/index.js
```

- `-s user` 는 모든 프로젝트에서 쓰게 등록합니다. 빼면 지금 프로젝트에서만 씁니다.
- nvm 을 쓰면 `node` 대신 `which node` 결과(절대 경로)를 넣습니다.
- 등록은 새 세션부터 적용됩니다(`/mcp` 로 연결 상태 확인).
- Claude Code 가 파일을 직접 읽으려 하면 "docbridge 로 열어줘"라고 하면 됩니다.

### Claude Desktop 에 빌드 결과를 손으로 등록

개발 중인 빌드를 Desktop 에서 볼 때만 씁니다. 위 `.mcpb` 확장과 같이 켜지 마세요(docbridge 가 두 번 뜹니다).

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
3. Claude Desktop 을 완전히 종료했다가 다시 엽니다.

`.mcpb` 를 직접 만들려면 `npm run pack`(→ `dist/docbridge-<버전>.mcpb`). 릴리스 때는 태그를 올리면 CI 가 만들어 Release 에 붙입니다.

### 함께 쓸 때

Claude Desktop 과 Claude Code 를 동시에 쓰면 docbridge 가 각각 따로 뜹니다(포트 7790, 7791 …). 뷰어 탭도 따로라서, 한쪽에서 연 문서는 다른 쪽에서 보이지 않습니다.

### 개발 문서

개발 명령과 폴더 구조는 [`CLAUDE.md`](CLAUDE.md), 기획과 스펙은 [`docs/`](docs/) 에 있습니다.

데모 영상(열기 → 근거 표시 → 옮기기 → 바꾸기 → 저장)은 `npm run demo` 로 다시 녹화합니다. 실제 서버·뷰어를 헤드리스 Chromium 으로 녹화해 `~/Downloads/docbridge-demo/` 에 webm(ffmpeg 가 있으면 mp4 도)과 정지 화면을 남깁니다.

## 감사

문서 파싱과 렌더링은 [rhwp](https://github.com/edwardkim/rhwp) (MIT) 의 `@rhwp/core` 를 씁니다.
