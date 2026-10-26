# rhwp GitHub 이슈·Discussions 분석: 사람들은 rhwp를 어떻게 쓰고, 어디서 막히는가

- 대상: https://github.com/edwardkim/rhwp (레포 생성 2026-03-27, 스타 3,989)
- 수집일: 2026-10-23, `gh api` REST(issues, comments) + GraphQL(discussions)
- 원시 데이터: `/private/tmp/claude-501/-Users-kimjin-wan-Works-personal/6612b130-8021-4a39-aae2-51c6580ab46c/scratchpad/rhwp-issues/`
  - `issues_p1..82.json`(원본 8,109건), `issues_all.json`(PR 제외 이슈 3,585건 요약), `issues_external.json`(외부 사용자 이슈 382건), `external_tagged.json`(분류 태그), `comments/`(외부 이슈 댓글), `discussions.json`(65건), `prs_all.json`(PR 4,524건), `prcomments/`(외부 PR 중 미병합 종료 243건 댓글), `detail/`(#8169, PR #8170 등 핵심 원문)
- 비교용 참고 자료(중복 분석은 하지 않음): `rhwp-code-analysis.md`, `cws-scrape/rhwp-ko-reviews.json`(크롬 스토어 리뷰 167개)

---

## 핵심 결론 5줄

1. **GitHub에 이슈를 올리는 외부 사용자는 대부분 개발자다.** 외부 이슈 382건 중 약 77%(296건)가 개발자 성격(코드, API, CLI)이고, 일반 사용자 목소리는 86건뿐이다. 실제 대중은 크롬 확장 쪽에 있다(주간 사용자 21만, 한국어 94%, Windows 81%, 평일에 많이 씀). "받은 공문·공고·신청서를 한글 없이 열어 보는" 용도가 중심이다.
2. **막히는 지점은 1위 표(139건), 2위 레이아웃 차이(136건), 3위 저장 후 한컴에서 깨짐(73건)이다.** 일반 사용자에게 가장 아픈 건 "rhwp에서 고쳐 저장한 파일을 한컴에서 열면 손상·변조라고 나온다"(#190, #7219, #1244, #698)이다. 고쳐서 돌려보내는 흐름이 아직 제일 약하다.
3. **AI 쪽은 업스트림이 이미 깊이 들어와 있다.** MCP 서버, CLI/MCP 편집 배선 30여 건, 에이전트 로드맵 100건 이상이 있다. 게다가 **오늘(10-23) rhwp-studio 안에 Claude API 키로 동작하는 "AI 도우미 대화 패널"(#8169, PR #8170, 도구 41개, 변경 카드 + 실행 취소 1회)이 PR로 올라왔다.** 반면 외부 사용자 중 "문단 이동"이나 "근거 하이라이트"를 요청한 사람은 0명이다. 외부의 AI 수요는 양식 자동 채우기, RAG·텍스트 추출, 보고서 자동 생성 파이프라인에 몰려 있다.
4. **메인테이너는 응답이 빠르고 외부 기여를 많이 받는다.** 첫 응답 중앙값은 29.5시간이고, 외부 PR은 종료 건의 약 85%가 병합이나 체리픽 통합으로 반영된다. 특히 임베드 RPC·이벤트 제안은 PR이 붙어 있으면 1~7일 안에 들어갔다(#7707, #7709, #4564, #2186). 대신 검증 요구가 높고, "공용 API·MCP는 업스트림, 서비스 화면·인증은 다운스트림"이라는 경계가 분명하다.
5. **우리 구상에 주는 시사점**: 타깃은 "받은 한글 문서를 한글 없이 읽고, 묻고, 조금 고쳐 돌려보내는 비개발자"다. 첫 시나리오는 **본문 글 위주의 공문·보고서에 대해 질문하고 근거를 하이라이트하는 것**과 **바꾸기·표 칸 채우기**다. 그림·도형 삽입, 중첩 표, 쪽 경계에 걸친 표, 수식, 머리말·꼬리말은 피한다. 차별점은 "API 키 없이 내가 쓰는 Claude 채팅(Desktop/Cowork/Code)으로" 다루고, "근거 하이라이트와 구조 편집(문단 이동)"을 하며, "저장 전 손상 검증"을 해 주는 것이다. 업스트림 studio AI 패널(PR #8170)과 같은 기능을 겨루면 진다.

---

## 0. 데이터 정제 방법

| 단계 | 건수 | 기준 |
|---|---:|---|
| 전체 항목(issues API) | 8,109 | `state=all` 82페이지 |
| PR 제외 | 3,585 | `pull_request` 필드가 없는 것 |
| 외부 사용자 이슈 | **382** (작성자 198명) | OWNER·COLLABORATOR 제외. 15건 이상 올린 고빈도 기여자 11명 제외(planet6897 980건, kevin9327 810건, jangster77, humdrum00001010, postmelee, lpaiu-cs, jeong-sik, johndoekim, semanticist21, davindev 등). 이들은 AI 에이전트로 작업 티켓을 대량 생성하는 내부 작업 계정에 가깝다. 봇 제외 |
| Discussions | 65 | 공지(크롬 확장 주간 지표) 다수. 외부 작성 글은 10여 건 |

주의할 점:
- 외부 이슈 상당수도 AI 도구로 분석·작성한 티가 난다(본문에 "Claude Code 도움을 받아 작성" 같은 명시가 있음. 예: #7992). 그래서 "개발자가 AI로 버그를 찾아 올리는" 이슈가 많다.
- 분류는 제목 키워드 기반 다중 라벨이다(제목에서 안 잡히면 본문 1,500자에서 최대 2개). 건수는 경향을 보는 용도로만 쓴다. 일반 사용자 이슈 판별은 본문에 코드·API·CLI 흔적이 없는지로 했다.

---

## 1. 사용자 유형과 사용 장면

### 1-1. 누가 쓰는가 (규모)

| 채널 | 규모·구성 | 출처 |
|---|---|---|
| 크롬 확장 | 주간 사용자 210,427명, 누적 설치 20.2만, 한국어 94.1%. OS는 Windows 80.9%, macOS 15.9%, ChromeOS 주간 사용자 1.07만(5.1%). 금·토에 줄고 평일에 많음(업무용 정황) | [D#8164](https://github.com/edwardkim/rhwp/discussions/8164) |
| 메인테이너가 정한 제품 목표 | "간단한 편집 수준에 만족하는 사용자가 꾸준히 사용하는 상태" | [D#6164](https://github.com/edwardkim/rhwp/discussions/6164) |
| GitHub 외부 이슈 | 382건 중 개발자 성격 296건(77%), 일반 사용자 86건(23%) | 이 분석 |
| 템플릿의 "사용 경로" 기입분(46건) | Studio 16, CLI 10, 라이브러리/API 9, CLI+MCP 2 등 | 본문 파싱 |
| 템플릿의 "운영체제" 기입분(34건) | Windows 17, macOS 13, Linux 2 | 본문 파싱 |
| 템플릿의 "문서 형식" 기입분(35건) | HWPX 14, HWP5 10, 둘 다 4 | 본문 파싱 |

크롬 스토어 리뷰 167개(별점 5점이 159개)는 "한글 없이 바로 열린다", "크롬북 학교에서 쓸 수 있다"는 칭찬이 대부분이다. 깨짐 불만은 리뷰보다 GitHub에 몰려 있다. 대중은 칭찬을 리뷰로 남기고, 문제는 개발자 성향 사용자가 GitHub로 가져오는 구조다.

### 1-2. 사용자 유형 × 문서 × 흐름

| 유형 | 문서 | 흐름 | 대표 이슈(요약) |
|---|---|---|---|
| **일반 사용자(개인·직장인)** | 공고문, 신청서, 보도자료, 휴가신청서, 입찰공고 | **받아서 보기**(한글 미설치, 맥, 크롬북) | [#1056](https://github.com/edwardkim/rhwp/issues/1056) 시청 지원사업 공고가 1쪽이 아니라 2쪽으로 보임 · [#6026](https://github.com/edwardkim/rhwp/issues/6026) 정부 보도자료의 격자선·이미지 차이 · [#2042](https://github.com/edwardkim/rhwp/issues/2042) 휴가신청서가 로고만 보이고 양식이 안 나옴 · [#232](https://github.com/edwardkim/rhwp/issues/232) 나라장터에서 내려받은 hwpx 자동 열기 실패 · [#241](https://github.com/edwardkim/rhwp/issues/241) 맥+브레이브에서 그림 때문에 공백이 생김 |
| 일반 사용자 | 같음 | **조금 고쳐서 한컴 사용자에게 돌려보내기** | [#190](https://github.com/edwardkim/rhwp/issues/190) 간단히 텍스트를 고쳐 저장했더니 한컴에서 "손상" · [#7219](https://github.com/edwardkim/rhwp/issues/7219) 표 안에 이미지를 넣고 HWPX로 저장하면 한컴이 "문서 변조"로 거부(협업 시) · [#1244](https://github.com/edwardkim/rhwp/issues/1244) 탭 초기화 · [#698](https://github.com/edwardkim/rhwp/issues/698) 표를 넣은 문서를 다시 열면 표 위치가 망가짐 |
| 일반 사용자 | 새 문서 | **새로 작성** | [#8146](https://github.com/edwardkim/rhwp/issues/8146) 첫 빈 문단에서 고른 글꼴이 한글 입력 시 초기화됨 · [#244](https://github.com/edwardkim/rhwp/issues/244) 맞춤법 검사 요청("이것 때문에 한컴을 씀") · [#7483](https://github.com/edwardkim/rhwp/issues/7483) 화살표 그리기 요청 |
| **교육(교사·학생·수험)** | 시험지(2단), 수식, 기출문제, 대학 평가 보고서 | 보기, 웹앱 업로드, 표 숫자 갱신 | [#218](https://github.com/edwardkim/rhwp/issues/218) LEET 기출 hwp를 웹앱 업로드에 쓰려는데 시험지 양식이 깨짐 · [#7826](https://github.com/edwardkim/rhwp/issues/7826)·[#7794](https://github.com/edwardkim/rhwp/issues/7794) 2단 시험지에서 머리 표·보기 상자가 겹침 · [#7105](https://github.com/edwardkim/rhwp/issues/7105)·[#7865](https://github.com/edwardkim/rhwp/issues/7865) 수식 파싱·기호 · [#7944](https://github.com/edwardkim/rhwp/issues/7944) 대학 평가 보고서 표에 한글·엑셀에서 복사한 숫자 블록을 칸별로 붙이고 싶음 |
| **공공·기업 업무 시스템(임베드)** | 기안문, 결재 문서, 공문 서식, 사내 양식 | 그룹웨어·기안기에 뷰어/에디터를 **임베드**, 누름틀로 값 주입, 호스트가 저장 | [#493](https://github.com/edwardkim/rhwp/issues/493)·[#633](https://github.com/edwardkim/rhwp/issues/633) 전자정부프레임워크(JDK 1.8) 기안기에 넣으며 누름틀 키 매칭·뷰어 모드·인쇄 트리거 요청 · [#7707](https://github.com/edwardkim/rhwp/issues/7707)~[#7711](https://github.com/edwardkim/rhwp/issues/7711) 바깥 "데이터 필드 패널"과 에디터 누름틀 연동 · [#4564](https://github.com/edwardkim/rhwp/issues/4564) 호스트가 저장을 맡을 때 스튜디오의 저장·드롭을 끄는 프로파일 · [#7626](https://github.com/edwardkim/rhwp/issues/7626) ChunkLab·AI-HUB 자체 호스팅에서 공문 서식 쪽 나눔이 회귀 · [#8127](https://github.com/edwardkim/rhwp/issues/8127) 자사 로그인 세션 확인 |
| **개발자(자동 생성·양식 채우기)** | 월간보고서 템플릿(235쪽, 필드 223개), 연구노트 12개월치, 시험문제 | 템플릿에 데이터 **일괄 채우기**, 표 행 동적 생성, 한컴 OLE 자동화 대체 | [#5819](https://github.com/edwardkim/rhwp/issues/5819) 건설·행정 월간보고서를 한컴 OLE 대신 rhwp CLI/MCP로 만들려고 표 생성 배선 요청 · [D#3498](https://github.com/edwardkim/rhwp/discussions/3498) 연구노트 docx/PDF를 HWP 양식에 일괄 변환. "표 구조를 LLM에 맡기면 6×3이 6×2로 어긋나서" 결정적 복제로 감 · [#270](https://github.com/edwardkim/rhwp/issues/270) set_field 값이 저장 후 유실("LLM 양식 자동 채움이 통째로 안 됨") · [#654](https://github.com/edwardkim/rhwp/issues/654) PDF·이미지를 HWPX 시험문제로 변환(OCR은 Claude Code Skill) |
| **개발자(추출·변환·RAG)** | 공공기관 RFP·제안요청서, 법령·공문, 강좌 안내 | 텍스트 추출, PDF 변환, 마크다운·RAG | [#7684](https://github.com/edwardkim/rhwp/issues/7684) RFP 12건 중 4건에서 0.8.2→0.8.7 업그레이드 후 `getPageTextLayout` 글자 소실(최대 2,461자). 그래서 0.8.2에 머묾 · [#6211](https://github.com/edwardkim/rhwp/issues/6211) export-pdf에서 표가 오른쪽으로 쏠림 · [#7501](https://github.com/edwardkim/rhwp/issues/7501) 행정업무운영 편람 PDF 변환 중단 · [#227](https://github.com/edwardkim/rhwp/issues/227)·[#3202](https://github.com/edwardkim/rhwp/issues/3202) 파이썬 바인딩·RAG · [D#114](https://github.com/edwardkim/rhwp/discussions/114) export-chunks |
| **개발자(파생 앱)** | 전반 | 다른 플랫폼 뷰어로 재포장 | [D#1415](https://github.com/edwardkim/rhwp/discussions/1415) iPad 뷰어 HWPad(App Store) · [#7986](https://github.com/edwardkim/rhwp/issues/7986) 안드로이드 경량 뷰어에서 WASM 메모리 증가 · [#981](https://github.com/edwardkim/rhwp/issues/981) Tauri 데스크톱 · [#698](https://github.com/edwardkim/rhwp/issues/698)·D#3498 HOP |

정리하면 실제 흐름은 다음 세 가지다.
1. **받아서 보기**: 가장 큰 집단이고, 크롬 확장을 쓰며 GitHub에서는 조용하다.
2. **임베드해서 업무 시스템에 넣기**: 기안기, 그룹웨어, 사내 AI 플랫폼.
3. **프로그램으로 채우기·추출하기**: 양식 채우기, 보고서 생성, RAG.

"받아서 조금 고쳐 돌려보내기"는 수요는 보이지만 저장 호환성에 막혀 있다.

---

## 2. 막히는 지점 Top

외부 이슈 382건, 다중 라벨. "일반 사용자" 열은 86건 기준이고 "열림"은 현재 열린 이슈 수다.

| 순위 | 분류 | 전체 | 일반 사용자 | 열림 | 대표 이슈(요약) |
|---:|---|---:|---:|---:|---|
| 1 | **표**(중첩, 쪽 경계 분할, 글자처럼 취급, 셀 편집) | 139 | 28 | 48 | [#8077](https://github.com/edwardkim/rhwp/issues/8077) 표가 통째로 안 보임 · [#4514](https://github.com/edwardkim/rhwp/issues/4514) 쪽 경계에서 표가 분할되지 않고 겹침(47쪽 중 6쪽) · [#8138](https://github.com/edwardkim/rhwp/issues/8138) 표 안 표를 편집하면 바깥 표가 바뀜 · [#1838](https://github.com/edwardkim/rhwp/issues/1838) 셀 안 줄바꿈 텍스트가 출력에서 누락 |
| 2 | **렌더링·레이아웃 차이**(겹침, 밀림, 쪽수 차이) | 136 | 18 | 38 | [#8123](https://github.com/edwardkim/rhwp/issues/8123) 글자 겹침·잘림 · [#7096](https://github.com/edwardkim/rhwp/issues/7096) 신청서 양식의 제목과 표가 겹침 · [#1056](https://github.com/edwardkim/rhwp/issues/1056) 1쪽 문서가 2쪽으로 보임 · [#7626](https://github.com/edwardkim/rhwp/issues/7626) 버전 업 후 공문 서식 2쪽이 1쪽으로 합쳐짐(회귀) |
| 3 | **저장·라운드트립 손상**(한컴에서 손상·변조·빈 문서) | 73 | 7 | 12 | [#190](https://github.com/edwardkim/rhwp/issues/190) 저장 후 한컴에서 손상 · [#7219](https://github.com/edwardkim/rhwp/issues/7219) "문서 변조" · [#8114](https://github.com/edwardkim/rhwp/issues/8114) 직렬화한 hwp가 한컴에서 빈 문서로 열림 · [#8001](https://github.com/edwardkim/rhwp/issues/8001) CRLF 텍스트를 편집해 저장하면 문단 뒷부분 유실 · [#7999](https://github.com/edwardkim/rhwp/issues/7999) 겹치는 일괄 치환이 뒤 본문까지 삭제 · [#3542](https://github.com/edwardkim/rhwp/issues/3542)~[#3547](https://github.com/edwardkim/rhwp/issues/3547) HWPX 저장 스키마 위반 |
| 4 | **편집 UX**(단축키, 캐럿, IME, 붙여넣기, 셀 블록) | 70 | 21 | 22 | [#3950](https://github.com/edwardkim/rhwp/issues/3950) 한글 입력 상태에서 Ctrl+A가 안 됨 · [#7281](https://github.com/edwardkim/rhwp/issues/7281) 맥 단축키 · [#7943](https://github.com/edwardkim/rhwp/issues/7943) 한컴에서 복사해 붙이면 칸 밖에 들어감 · [#6449](https://github.com/edwardkim/rhwp/issues/6449) Gmail HTML을 붙이면 브라우저가 멈춤 |
| 5 | API·임베드·자동화 결함·공백 | 65 | 3 | 11 | [#271](https://github.com/edwardkim/rhwp/issues/271) 문단 삭제 API 없음(해결) · [#8086](https://github.com/edwardkim/rhwp/issues/8086) embed RPC `loadFile` 경로만 재조판이 안 됨 · [#522](https://github.com/edwardkim/rhwp/issues/522)·[#2389](https://github.com/edwardkim/rhwp/issues/2389) iframe loadFile 경합·교착 |
| 6 | 그림·도형·글상자·직인 | 63 | 13 | 18 | [#2042](https://github.com/edwardkim/rhwp/issues/2042) · [#3308](https://github.com/edwardkim/rhwp/issues/3308) PDF에서 '직인' 글상자 위치 이탈 · [#7625](https://github.com/edwardkim/rhwp/issues/7625) 글 뒤 직인이 표 아래에 깔림 |
| 7 | 글꼴·글자 표시 | 37 | 9 | 10 | [#1689](https://github.com/edwardkim/rhwp/issues/1689) 글꼴·색·개요번호가 다름 · [#2099](https://github.com/edwardkim/rhwp/issues/2099) 아래아 표시 불가 · [#616](https://github.com/edwardkim/rhwp/issues/616) 글꼴이 없어 다르게 보임 · [#6936](https://github.com/edwardkim/rhwp/issues/6936) PDF에서 굵게가 사라짐 |
| 8 | **환경·설치·배포**(크롬 확장, 맥, 리눅스, 드라이브) | 28 | 14 | 3 | [#7664](https://github.com/edwardkim/rhwp/issues/7664) 크롬 "저장 위치 확인" 설정이 켜져 있으면 로컬 HWP가 안 열림 · [#1131](https://github.com/edwardkim/rhwp/issues/1131) file:// 권한 안내 부재 · [#8098](https://github.com/edwardkim/rhwp/issues/8098) 구글 계정 여러 개일 때 드라이브 열기 실패 · [#7839](https://github.com/edwardkim/rhwp/issues/7839) 리눅스 크롬에서 대화상자가 안 열림 · [#1493](https://github.com/edwardkim/rhwp/issues/1493) "PC의 hwp 파일이 외부로 전송된다"는 프라이버시 오해 |
| 9 | PDF·내보내기 | 27 | 4 | 5 | [#6211](https://github.com/edwardkim/rhwp/issues/6211) · [#1583](https://github.com/edwardkim/rhwp/issues/1583) · [#7858](https://github.com/edwardkim/rhwp/issues/7858) |
| 10 | 머리말·꼬리말·각주·쪽번호 | 18 | 2 | 6 | [#6986](https://github.com/edwardkim/rhwp/issues/6986) 꼬리말 쪽번호가 빈칸(회귀) · [#7441](https://github.com/edwardkim/rhwp/issues/7441) · [#7472](https://github.com/edwardkim/rhwp/issues/7472) |
| 11 | 파일 열기 실패(HWP3, HWPML, 암호, 손상 CFB) | 17 | 7 | 1 | [#1703](https://github.com/edwardkim/rhwp/issues/1703) HWP 3.0 · [#1157](https://github.com/edwardkim/rhwp/issues/1157) HWPML · [#7674](https://github.com/edwardkim/rhwp/issues/7674) 암호 문서 |
| 12 | 수식 | 15 | 2 | 4 | [#7105](https://github.com/edwardkim/rhwp/issues/7105) · [#5534](https://github.com/edwardkim/rhwp/issues/5534) |
| 13 | 성능·메모리 | 10 | 0 | 3 | [#7639](https://github.com/edwardkim/rhwp/issues/7639) 거대 표 문서 로딩 60초 · [#7986](https://github.com/edwardkim/rhwp/issues/7986) 모바일 WASM 메모리 1GB 넘음 · [#8162](https://github.com/edwardkim/rhwp/issues/8162) 입력할 때마다 전체 글자 위치를 다시 재서 느림 |

추가 관찰:
- **버전 회귀가 잦다.** [#7684](https://github.com/edwardkim/rhwp/issues/7684)(텍스트 추출 소실), [#7626](https://github.com/edwardkim/rhwp/issues/7626)(쪽 나눔), [#6986](https://github.com/edwardkim/rhwp/issues/6986)(쪽번호), [#4698](https://github.com/edwardkim/rhwp/issues/4698)(셀 텍스트 4자 누락), [#7857](https://github.com/edwardkim/rhwp/issues/7857)이 그 예다. 7개월 동안 이슈·PR이 8천 건 넘게 쌓이는 속도라, 다운스트림은 버전을 고정하고 자체 회귀 문서 세트를 갖춰야 한다.
- 환경 문제는 일반 사용자 비중이 가장 높다(28건 중 14건). 크롬 확장의 다운로드 가로채기, file 권한, 맥 단축키 같은 "설치·열기 경로"에서 비개발자가 가장 먼저 막힌다.

---

## 3. AI·자동화 관련

### 3-1. 업스트림(내부)이 이미 하고 있는 것

| 항목 | 내용 | 근거 |
|---|---|---|
| MCP 서버 | `rhwp mcp-serve`(stdio)와 18개 호스트 붙이기 킷, 루트 `.mcp.json` | [#4724](https://github.com/edwardkim/rhwp/issues/4724), [#4856](https://github.com/edwardkim/rhwp/issues/4856), [#4782](https://github.com/edwardkim/rhwp/issues/4782) |
| CLI/MCP 편집 배선 | 문단 삽입·삭제·분할·병합, 표 행·열·셀, 각주, 책갈피 등 30여 건(#3608 M8~M11) | [#4990](https://github.com/edwardkim/rhwp/issues/4990)~[#5110](https://github.com/edwardkim/rhwp/issues/5110) |
| 에이전트 로드맵 | "에이전트-네이티브 로드맵 R1~R200", 문서 선택자 언어(DSEL)·Op·Txn 커널, 에이전트 gym·벤치마크 | [#3907](https://github.com/edwardkim/rhwp/issues/3907), [#4875](https://github.com/edwardkim/rhwp/issues/4875), [#4464](https://github.com/edwardkim/rhwp/issues/4464), [#6684](https://github.com/edwardkim/rhwp/issues/6684) |
| Claude Code 스킬 | 서식 채우기(누름틀·메일머지), 표 CSV 왕복, 안전 편집(dry-run·verify), 출처 표지·주입 방어 등 | [#4212](https://github.com/edwardkim/rhwp/issues/4212), [#5294](https://github.com/edwardkim/rhwp/issues/5294), [#5300](https://github.com/edwardkim/rhwp/issues/5300) |
| LLM용 추출 | `export-llm`(RAG 청킹, 출처 앵커, untrusted 표지), DocLang 내보내기 | [#4869](https://github.com/edwardkim/rhwp/issues/4869), [#3131](https://github.com/edwardkim/rhwp/issues/3131) |
| **studio AI 도우미 패널** | **2026-10-23 생성, PR 열림.** 사용자가 Claude API 키를 등록하는 방식. 읽기 도구 8개, 쓰기 30개, 허용 명령 3개. 변경마다 카드로 적용·거절하고 실행 취소 1회로 되돌림. "새 문서로 회의록 양식 만들어 줘"를 약 60초에 완료. **크롬·파이어폭스 확장 빌드에는 들어가지 않음**(`RHWP_WITHOUT_AI`). 플러그인 호스트에 `ui.registerSidePanel`, 선택 글 읽기, 글 범위 선택 추가. 문단 "이동"은 범위에 없음(추가·삭제만) | [#8169](https://github.com/edwardkim/rhwp/issues/8169), [PR #8170](https://github.com/edwardkim/rhwp/pull/8170) (+11,140줄) |
| 메인테이너 입장 | "LLM으로 HWPX 만들기" 성공은 대부분 좁은 성공이고 표·이미지·재저장 호환은 실패한다는 글. 표 구조는 LLM이 아니라 결정적 연산으로 다루는 게 프로젝트 지향 | [D#184](https://github.com/edwardkim/rhwp/discussions/184), [D#3498](https://github.com/edwardkim/rhwp/discussions/3498) 답변 |

### 3-2. 외부 사용자의 AI·자동화 사용 사례와 요청

외부 382건 중 AI·LLM·MCP를 **실제 사용 맥락으로** 언급한 것은 약 15건이다(본문의 "AI로 작성" 표기는 제외).

| 사례 | 무엇을 하려 했나 | 이슈 |
|---|---|---|
| 자체 rhwp-mcp 구축(Node, @rhwp/core 0.7.3) | LLM 에이전트가 양식 필드를 채우고 문단을 지우려 함. 문단 삭제·끝에 추가 API 부재, HwpCtrl 액션 미노출, set_field 저장 유실을 연달아 보고 | [#268](https://github.com/edwardkim/rhwp/issues/268)~[#272](https://github.com/edwardkim/rhwp/issues/272) (4건 해결, #272는 v2.0으로 이관) |
| 월간보고서 자동 생성 | 한컴 OLE를 rhwp CLI/MCP로 대체(표 생성·열 너비·필드 기준 삽입) | [#5819](https://github.com/edwardkim/rhwp/issues/5819) (3주 만에 반영) |
| 연구노트 양식 일괄 채우기(HOP 기반) | LLM에 표 구조를 맡기지 않고 결정적 복제 후 내용만 채우는 연산 9종 | [D#3498](https://github.com/edwardkim/rhwp/discussions/3498) → [#3587](https://github.com/edwardkim/rhwp/issues/3587) |
| 인허가 자료 수정 에이전트 | 환경 인허가 문서를 고치는 에이전트를 만들다 화살표 출력 미지원에 막힘 | [#7483](https://github.com/edwardkim/rhwp/issues/7483) |
| CLI/MCP 일괄 치환 | 말줄임표 일괄 치환이 뒤 본문을 삭제하는데 `--verify`가 못 잡음, CRLF 삽입 시 유실 | [#7999](https://github.com/edwardkim/rhwp/issues/7999), [#8001](https://github.com/edwardkim/rhwp/issues/8001) |
| 시험문제 변환 파이프라인 | PDF·이미지·MD·DOCX를 HWPX 시험지로(OCR은 Claude Code Skill) | [#654](https://github.com/edwardkim/rhwp/issues/654) 계열 |
| LLM 연동 편집 예제 | Next.js에서 LLM으로 HWP 캔버스 편집. 설명이 부족해 메인테이너가 범위를 되물음 | [#1372](https://github.com/edwardkim/rhwp/issues/1372) |
| AI 워크로드 FFI | C#·Java 바인딩. C# PR 수용 | [#403](https://github.com/edwardkim/rhwp/issues/403) |
| RAG·마크다운 | 투표 댓글에서 "markitdown 같은 파싱", 시맨틱 청킹·메타데이터 요청 | [D#54](https://github.com/edwardkim/rhwp/discussions/54), [D#114](https://github.com/edwardkim/rhwp/discussions/114), [#227](https://github.com/edwardkim/rhwp/issues/227), [#3202](https://github.com/edwardkim/rhwp/issues/3202) |
| 텍스트 추출 신뢰성 | RFP 추출에서 버전 업 후 글자 소실 | [#7684](https://github.com/edwardkim/rhwp/issues/7684) |

### 3-3. 특히 찾은 것: 문단 이동, 구조 편집, 질의응답, 하이라이트

| 요청 유형 | 전체 3,585건 중 | 외부 382건 중 | 비고 |
|---|---:|---:|---|
| **문단 이동·순서 바꾸기** | 0 | **0** | "문단 이동/move paragraph" 요청 없음. 비슷한 것은 문단 삭제([#271](https://github.com/edwardkim/rhwp/issues/271)), 끝에 추가([#269](https://github.com/edwardkim/rhwp/issues/269)), 내부 CLI의 `split/merge-paragraph`, 표 행 이동 정도 |
| **범위 하이라이트·근거 표시** | 0(기능 요청 기준) | **0** | 하이라이트 관련은 모두 studio 드래그 선택 표시 버그([#4272](https://github.com/edwardkim/rhwp/issues/4272), [#7227](https://github.com/edwardkim/rhwp/issues/7227)). PR #8170이 플러그인 호스트에 "글 범위 선택"을 추가함 |
| 문서 질의응답(채팅으로 묻기) | 1(#8169 내부) | 0 | 외부 요청은 RAG·추출 쪽으로만 나타남 |
| 임베드 호스트와 에디터 사이 이벤트·명령 | 다수 | 약 11 | 누름틀 진입 이벤트, 매개변수 삽입, 커서 동기화, 문서 변경 이벤트(`document-change-events-v1` 존재) |

해석: "말로 문단을 옮기고, 묻고, 근거를 하이라이트하는" 사용 방식은 **외부 수요가 아직 드러나지 않은 빈 영역**이다. 기회일 수도 있지만, 수요를 검증해야 한다는 신호이기도 하다. 외부 AI 수요는 결정적인 양식 채우기와 추출에 몰려 있다.

---

## 4. 기능 요청 Top (외부 이슈와 Discussions를 손으로 묶어 집계)

| 순위 | 요청 묶음 | 건수 | 대표 |
|---:|---|---:|---|
| 1 | **프로그램 편집 API 보강**(문단 삭제·추가, 표 생성, 칸 경로 API, 쪽번호, 상호 참조, 칸 안 그림, HwpCtrl 액션) | ~15 | [#271](https://github.com/edwardkim/rhwp/issues/271), [#269](https://github.com/edwardkim/rhwp/issues/269), [#5819](https://github.com/edwardkim/rhwp/issues/5819), [#7635](https://github.com/edwardkim/rhwp/issues/7635)~[#7637](https://github.com/edwardkim/rhwp/issues/7637), [#7996](https://github.com/edwardkim/rhwp/issues/7996), [#8138](https://github.com/edwardkim/rhwp/issues/8138), [#6349](https://github.com/edwardkim/rhwp/issues/6349), [#272](https://github.com/edwardkim/rhwp/issues/272), [D#3498](https://github.com/edwardkim/rhwp/discussions/3498) |
| 2 | **배포 채널·언어 바인딩**(PyPI, crates.io, FFI, 릴리스 바이너리, Tauri/Electron, PWA, 파이어폭스) | ~13 | [#227](https://github.com/edwardkim/rhwp/issues/227), [#5446](https://github.com/edwardkim/rhwp/issues/5446), [#403](https://github.com/edwardkim/rhwp/issues/403), [#5949](https://github.com/edwardkim/rhwp/issues/5949), [#1341](https://github.com/edwardkim/rhwp/issues/1341), [#151](https://github.com/edwardkim/rhwp/issues/151) |
| 3 | **임베드 연동**(읽기 전용, 툴바·인쇄 트리거, MessageChannel, 이벤트, 호스트 저장 프로파일, 오프라인 글꼴) | ~11 | [#226](https://github.com/edwardkim/rhwp/issues/226), [#633](https://github.com/edwardkim/rhwp/issues/633), [#2186](https://github.com/edwardkim/rhwp/issues/2186), [#4564](https://github.com/edwardkim/rhwp/issues/4564), [#7707](https://github.com/edwardkim/rhwp/issues/7707)~[#7710](https://github.com/edwardkim/rhwp/issues/7710), [#3585](https://github.com/edwardkim/rhwp/issues/3585) |
| 4 | **한컴식 편집 기능**(F5 블록, 표 나누기, 셀 전치, 맥 단축키, 그림 드래그, 화살표, 맞춤법, 칸별 붙여넣기) | ~10 | [#220](https://github.com/edwardkim/rhwp/issues/220), [#3830](https://github.com/edwardkim/rhwp/issues/3830), [#223](https://github.com/edwardkim/rhwp/issues/223), [#244](https://github.com/edwardkim/rhwp/issues/244), [#7944](https://github.com/edwardkim/rhwp/issues/7944), [#7483](https://github.com/edwardkim/rhwp/issues/7483) |
| 5 | **변환·추출**(HWP→HWPX, PDF 글꼴 지정, 텍스트·마크다운, RAG 청킹, Export API) | ~9 | [#1868](https://github.com/edwardkim/rhwp/issues/1868), [#1747](https://github.com/edwardkim/rhwp/issues/1747), [#263](https://github.com/edwardkim/rhwp/issues/263), [#377](https://github.com/edwardkim/rhwp/issues/377), [D#114](https://github.com/edwardkim/rhwp/discussions/114) |
| 6 | **양식·누름틀 자동 채우기** | ~7 | [#258](https://github.com/edwardkim/rhwp/issues/258), [#493](https://github.com/edwardkim/rhwp/issues/493), [#270](https://github.com/edwardkim/rhwp/issues/270), [#721](https://github.com/edwardkim/rhwp/issues/721), [#838](https://github.com/edwardkim/rhwp/issues/838), [#1512](https://github.com/edwardkim/rhwp/issues/1512) |
| 7 | 파일 열기 경로(OneDrive, 구글 드라이브, OS 파일 연결, HWP3, 암호) | ~5 | [#242](https://github.com/edwardkim/rhwp/issues/242), [#8098](https://github.com/edwardkim/rhwp/issues/8098), [#596](https://github.com/edwardkim/rhwp/issues/596), [#254](https://github.com/edwardkim/rhwp/issues/254) |
| 8 | 영어 UI | 1 | [#5852](https://github.com/edwardkim/rhwp/issues/5852) |

초기 투표([D#54](https://github.com/edwardkim/rhwp/discussions/54))의 후보에는 "AI 문서 처리 API(LLM이 읽고 생성)"가 있었다. 댓글 3개는 마크다운 파싱, RAG용 청킹, ODT 내보내기, 그리고 "잡다한 기능보다 한컴 호환을 먼저"를 요구했다.

---

## 5. 메인테이너 대응 성향

### 5-1. 응답·처리 속도 (외부 이슈 382건)

| 지표 | 값 |
|---|---|
| 메인테이너(OWNER, COLLABORATOR, 핵심 기여자)가 댓글을 단 이슈 | 263건(69%) |
| 첫 응답 시간 | 중앙값 **29.5시간**, p25 4.9시간, p75 104시간, p90 285시간 |
| 24시간 / 72시간 안에 응답 | 120건(46%) / 185건(70%) |
| 종료까지 | 292건 종료, 중앙값 **44시간**, p75 162시간 |
| 응답 없이 열려 있음 | 72건(대부분 10월 급증분, 미응답 열린 건의 중앙 연령 12일). 10월 외부 이슈가 90건으로 평소의 2배 |
| 첫 응답자 | edwardkim 132, jangster77 79, postmelee 26, planet6897 25 |

### 5-2. 외부 기여 수용

| 지표 | 값 |
|---|---|
| 외부 PR | 377건(작성자 93명). 직접 병합 127, 미병합 종료 243, 열림 7 |
| 미병합 종료 243건의 사유(댓글 키워드 추정) | **체리픽·통합 PR로 반영 약 186**, 중복·대체 10, 거절 10, 기타 27, 무응답 10 |
| 실질 반영률(추정) | 종료 370건 중 약 313건(**약 85%**) |
| 반영 방식 | 메인테이너가 원 PR을 "통합 PR"로 다시 묶고 보정해 넣는 경우가 많음(원 PR은 closed로 남음). 기여자 표기는 유지 |

### 5-3. 우리 같은 제안의 선례

| 제안 | 결과 | 걸린 기간 |
|---|---|---|
| [#271](https://github.com/edwardkim/rhwp/issues/271) 문단 삭제 WASM API | 다른 기여자 PR로 해결 | 5일 |
| [#2186](https://github.com/edwardkim/rhwp/issues/2186) @rhwp/editor MessageChannel transport | 외부 PR 병합 | 2일 |
| [#4564](https://github.com/edwardkim/rhwp/issues/4564) 임베드 UI 프로파일 | 외부 PR 병합 | 1일 |
| [#7707](https://github.com/edwardkim/rhwp/issues/7707) 매개변수로 누름틀 삽입 | 외부 PR 병합 | 1일 |
| [#7708](https://github.com/edwardkim/rhwp/issues/7708)~[#7710](https://github.com/edwardkim/rhwp/issues/7710) 커서 동기화, **누름틀 진입 이벤트(capability 협상)**, getPageSvg 프로필 | 통합 PR로 반영 | 7일 |
| [#5551](https://github.com/edwardkim/rhwp/issues/5551) 렌더 트리에 캡션 소유자 노출 | 반영 | 23일 |
| [D#3498](https://github.com/edwardkim/rhwp/discussions/3498) 양식 후처리 연산 9종 | "방향이 맞고 환영. 개별 native 함수로, 연산별 계약 테스트와 HWP5/HWPX 저장 왕복 확인, 이슈로 스펙 먼저 합의" → 메인테이너가 직접 착수 | 1일 답변 |
| [#272](https://github.com/edwardkim/rhwp/issues/272) HwpCtrl 312 액션 WASM 노출 | v2.0 마일스톤으로 이관(큰 범위) | 보류 |
| [#226](https://github.com/edwardkim/rhwp/issues/226) 읽기 전용 모드 | "core로 직접 만들라, 부족하면 PR로" | 6일 종료 |
| [#1372](https://github.com/edwardkim/rhwp/issues/1372) LLM 연동 편집 예제 | 범위가 불명확해 되물은 뒤 종료 | 5일 |
| [#8127](https://github.com/edwardkim/rhwp/issues/8127) 특정 서비스 로그인 연동 | 열림(로드맵상 다운스트림 범위) | - |

### 5-4. 로드맵과 경계 (ROADMAP.md)

- 현재 목표는 v1.0 "조판 엔진 체계화(한컴과 같은 쪽 배치)"이고, v2.0 "협업·AI·외부 프로그램 생태계"를 함께 진행한다.
- **업스트림 범위**: 공통 Web/WASM API, "서비스 연계 표면(CLI 기계 판독 출력, MCP 서버, 공개 API 계약)", 여러 다운스트림이 재사용할 공용 API.
- **다운스트림 범위**: 특정 서비스 인증, 전용 화면, 업무 절차, 완제품 앱 셸·설치·파일 연결.
- AI 세부 로드맵은 `mydocs/tech/agent_roadmap/`, [#2659](https://github.com/edwardkim/rhwp/issues/2659), [#3608](https://github.com/edwardkim/rhwp/issues/3608)에 있다. **브라우저 뷰어와 로컬 MCP를 잇는 브리지는 로드맵·이슈 어디에도 없다.** 임베드는 MessageChannel 단일 origin 설계다.
- PR 장벽: CONTRIBUTING이 로컬 사전 검증 기록을 요구하고, 조판 변경은 쪽별 TSV가 90% 미만이면 재검토한다. API·studio 변경은 TSV 대상이 아니다(PR #8170도 비해당으로 처리).

### 5-5. 우리 기여가 받아들여질 가능성

| 기여 후보 | 전망 | 근거와 조건 |
|---|---|---|
| `moveParagraphBlock`(같은 문서에서 문단 블록 이동, 1 트랜잭션, 1 undo) | **높음** | 문단 삭제 API가 5일 만에 들어갔고, D#3498에서 문서 정리 연산을 `document_core` 범위로 인정했다. 조건: 개별 native 함수, 계약 테스트, HWP5/HWPX 저장 왕복, 이슈로 스펙 먼저 합의. 각주·책갈피·자동번호가 든 문단의 경계 동작을 명시해야 한다 |
| embed RPC `highlightRanges`/`focusRange`(범위 하이라이트·스크롤) | **중상** | 누름틀 이벤트·getPageSvg 프로필 같은 임베드 확장이 capability 협상 방식으로 1주 안에 들어갔다. 다만 PR #8170이 플러그인 호스트에 "글 범위 선택"을 넣는 중이라 **그 API와 겹치지 않게 맞춰야 한다**. PR #8170 리뷰 흐름을 보고 같은 표면을 재사용하는 형태로 제안하는 편이 낫다 |
| 로컬 WebSocket 브리지·MCP↔브라우저 연결 자체 | **낮음** | 로드맵상 서비스·제품 화면은 다운스트림이고, 임베드 보안 경계(단일 origin)와 방향이 다르다. 우리 쪽에 둔다 |

---

## 6. 결론: 우리 구상에 주는 시사점

### 6-1. 타깃
- **1차**: "한글이 없거나 가끔 쓰는 직장인·공무원·교사"로, 받은 공문·공고·신청서·보고서를 **읽고, 묻고, 조금 고쳐 다시 보내야** 하는 사람. 크롬 확장 21만 주간 사용자가 같은 모집단이다(Windows 81%, 맥 16%, 크롬북 5%).
- 단, GitHub에서 이 집단의 "AI로 묻고 고치기" 요구는 아직 드러나지 않았다. 직접 인터뷰나 데모로 검증해야 한다.
- 2차로는 양식 일괄 채우기를 하려는 반개발자가 있다(외부 AI 수요의 중심). 이들은 업스트림 CLI/MCP로도 이미 많은 걸 할 수 있다.

### 6-2. 첫 사용 시나리오(권장 순서)
1. **문서에 질문 → 답 + 근거 하이라이트(읽기 전용)**: 저장 손상 위험이 0이고 렌더 차이에도 비교적 강하다. 단, 텍스트 추출 회귀([#7684](https://github.com/edwardkim/rhwp/issues/7684))가 있으니 **버전을 고정하고 우리 문서 세트로 회귀 검사**를 해야 한다.
2. **바꾸기와 표 칸 채우기**: 업스트림도 `replace-text`, `set-cell`, `fill-fields`를 가장 먼저 다듬은 경로다. 그래도 겹치는 치환([#7999](https://github.com/edwardkim/rhwp/issues/7999))과 CRLF([#8001](https://github.com/edwardkim/rhwp/issues/8001)) 같은 함정은 우리 쪽에서 미리 막는다.
3. **문단 이동**: 우리만의 기능이지만 업스트림 API가 없으니 직접 만들거나 기여해야 한다. 자동 번호·각주가 든 문단은 1단계에서 제외한다.

### 6-3. 피해야 할 문서 요소(첫 버전 지원 범위 밖, 또는 경고 표시)
- 중첩 표, 쪽 경계에 걸친 표, 글자처럼 취급한 표·그림, 표 안 그림(표 관련 139건, 저장 시 "문서 변조" #7219)
- 떠 있는 그림·글상자·직인, 글 뒤 개체(#3308, #7625)
- 머리말·꼬리말·쪽번호·각주(회귀 이력 #6986, #7472)
- 수식, 2단 시험지 서식
- **그림·도형을 새로 넣는 편집**(저장 호환성이 가장 약함)
- 배포용·암호 문서, HWP3·HWPML(열기 실패)
- 저장은 반드시 **원본 보존 + 다시 열어 검증 + 한컴 호환 경고**를 거친다. 일반 사용자 최대 불만이 "한컴에서 손상"이다.

### 6-4. 차별점(업스트림 studio AI 패널 PR #8170과 겹치지 않게)

| 축 | 업스트림 PR #8170 | 우리 구상 |
|---|---|---|
| AI 접점 | studio 안의 패널, **사용자 Claude API 키**(종량 과금, 키 관리) | **사용자가 이미 쓰는 Claude 채팅(Desktop/Cowork/Code) 구독 그대로**, 로컬 MCP |
| 설치 범위 | 웹 studio만(크롬·파이어폭스 확장 빌드에서는 제외) | 로컬 파일과 브라우저 뷰어, 대화 맥락(메일·다른 파일)과 함께 사용 |
| 읽기 | 개요·쪽 글·검색 등 8개 도구 | **근거 하이라이트**(답의 출처 범위를 뷰어에서 표시·스크롤) |
| 편집 | 쓰기 30개(추가·삭제·서식·표·개체), 변경 카드 | 비개발자가 자주 하는 **구조 편집(문단 이동)**, 바꾸기, 칸 채우기에 집중. 저장 전 손상 검증 |
| 겨루면 안 되는 것 | 서식·개체 삽입 전반, 새 문서 작성 | 같은 범위로 만들면 업스트림이 더 빨리, 더 넓게 한다 |

**한 줄 요약**: "받은 한글 문서를, 내 Claude 대화창에서, 근거를 짚어 가며 묻고, 문단·표 칸 수준으로 안전하게 고쳐, 한컴 사용자에게 깨지지 않게 돌려보내기"이다. 엔진의 약점(표, 개체, 저장 호환)은 범위를 좁혀 피한다. 업스트림에는 `moveParagraphBlock`과 범위 하이라이트 RPC 두 가지만 작게 기여한다.

---

## 출처
- 이슈 목록: `gh api repos/edwardkim/rhwp/issues?state=all&per_page=100&page=1..82`
- Discussions: GraphQL `repository.discussions`(65건)
- 핵심 원문: [#8169](https://github.com/edwardkim/rhwp/issues/8169), [PR #8170](https://github.com/edwardkim/rhwp/pull/8170), [D#8164](https://github.com/edwardkim/rhwp/discussions/8164), [D#6164](https://github.com/edwardkim/rhwp/discussions/6164), [D#3498](https://github.com/edwardkim/rhwp/discussions/3498), [D#184](https://github.com/edwardkim/rhwp/discussions/184), [D#54](https://github.com/edwardkim/rhwp/discussions/54), [D#114](https://github.com/edwardkim/rhwp/discussions/114)
- 로드맵: `rhwp-src2/repo/ROADMAP.md`(업스트림·다운스트림 경계 172~227행, AI 세부 로드맵 246행 이후), `CONTRIBUTING.md`
- 비교: `rhwp-code-analysis.md`(MCP는 파일 기반, 문단 이동·하이라이트 RPC 없음), 크롬 스토어 리뷰 167개(5점 159개)
