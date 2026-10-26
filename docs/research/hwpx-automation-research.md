# 조사 완료: AI 기반 한글(HWP/HWPX) 문서 자동화 재설계

조사일: 2026-10-23 / 표기: [추정] = 직접 확인하지 못한 내용, (출처 번호)는 하단 목록 참조

---

## 1. HWPX 포맷

### 1-1. 표준과 스펙 문서
- OWPML은 2011-12-30 KS X 6101로 제정된 국가표준이고, HWPML을 기반으로 한다. 한컴 다운로드 페이지는 원문을 직접 주지 않고 KSSN(국가표준 통합정보) / e나라표준인증 쪽으로 링크한다 (1, 2). 이후 KS X 6101:2024 개정판이 있다는 언급이 있다 (3). 무료로 원문 PDF를 받을 수 있는지는 확인하지 못했다. KS 표준은 보통 유료 열람이다 [추정].
- 한컴이 공개한 형식 문서(HWP/PDF): HWP 5.0 rev1.3(2010 공개, 2014 보완), HWP 3.0/HWPML rev1.2, 배포용 문서, 수식, 차트 (1). **HWPX(OWPML) 전용 스펙 문서는 이 페이지에 없다.** HWP 5.0 스펙을 참고해 만든 제품은 "본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다"라는 문구를 넣어야 한다 (1).
- 한컴은 HWPX를 ISO 국제표준으로 등재하는 작업을 2026년 안에 마치겠다고 밝혔다 (2025-09 KCSF 발표) (4). 실제로 등재됐는지는 확인하지 못했다.
- 결론: 실무에서 쓸 수 있는 공개 "스펙"은 사실상 없다. **실제 한글이 저장한 샘플 파일을 역분석하는 것과 오픈소스 구현체의 코드**가 사실상의 레퍼런스다.

### 1-2. 패키지 구조 (5, 6, 7)
| 경로 | 역할 |
|---|---|
| `mimetype` | 반드시 ZIP의 첫 엔트리여야 하고, 압축하지 않은 상태(STORED)로 저장한다 |
| `META-INF/container.xml`, `manifest.xml` | 컨테이너와 암호화 정보 |
| `Contents/content.hpf` | OPF 형식 패키지 목록(metadata/manifest/spine) |
| `Contents/header.xml` | 글꼴(fontfaces), 글자모양(charPr), 문단모양(paraPr), 스타일(style), 테두리/배경(borderFill), 번호/개요(numbering) 정의. 본문은 ID로 이 정의를 참조한다 |
| `Contents/section0.xml`, `section1.xml`… | 구역별 본문. 구조는 `hp:p`(문단) > `hp:run`(charPrIDRef) > `hp:t`(텍스트). 표·그림·필드는 run 안의 컨트롤로 들어간다 |
| `BinData/` | 이미지와 OLE 개체 |
| `Preview/PrvText.txt`, `PrvImage.png` | 미리보기 |
| `settings.xml`, `version.xml` | 설정, 버전 |

- 일부 자료는 본문을 `content.hml`, `[Content_Types].xml`로 적는데, 이는 생성기마다 다르거나 서술이 잘못된 것으로 보인다. 한글이 실제로 저장한 파일을 풀어서 확인해야 한다 (6, 8).
- **중요한 함정**: `hp:linesegarray`는 한글이 계산해 둔 줄 배치 캐시다. 텍스트를 바꾸고 이 캐시를 그대로 두면 한글이 줄을 다시 계산하지 않는다. 그 결과 자간이 압축되거나 글자가 겹친다. 이를 피하려면 캐시를 지우거나 flags를 고쳐야 한다 (9). canine89/hwpxskill의 `finalize_hwpx.py`도 같은 문제를 처리하는 스크립트다 (10).

### 1-3. 한컴 공개 자료와 SDK
- `hancom-io/hwpx-owpml-model`: C++ OWPML 필터 모델, Apache-2.0, 마지막 업데이트 2023-10. Windows/VS2017/x86 빌드 전용이고 샘플도 첫 구역 텍스트 추출뿐이다. 사실상 방치 상태다 (11, 12).
- `hancom-io/dvc`: HWPX 문서 검증기(C++, 2023-09). `metatag-ex`: 메타태그 추출 예제(Apache-2.0) (11).
- 한컴 Hwp SDK(상용): HWP/HWPX 생성·편집·HTML/PDF 변환 기능을 담은 함수 약 1,000개. 지원 플랫폼과 가격은 공개돼 있지 않다 (13).
- 한컴 공식 MCP 서버나 공개 개발자 API는 **찾지 못했다** (14, 4).

### 1-4. 기본 저장 형식과 공공기관 동향
- Windows 한글: 2021년 4월 정기 패치부터 HWPX가 기본 저장 형식이다 (15). 맥용 한글: 2023년 12월 최신판부터 HWPX가 기본이다 (16).
- 정부(국가AI전략위원회, 행안부, 문체부)는 2026-04-23 보도에서 공공 문서 유통 채널의 .hwp 첨부를 단계적으로 제한하겠다고 밝혔다. 온나라시스템은 5월부터, 공직자통합메일은 10월부터다 (17). 같은 시기 ChatGPT가 HWP/HWPX 업로드를 지원하기 시작했고(2026-04), Gemini 3도 한글 문서를 읽는다(2025-12) (17).
- 시사점: **산출물은 HWPX로 만드는 것이 시대 흐름과 맞다.** 다만 받는 쪽이 .hwp만 받는 경우가 남아 있다 [추정]. 이때는 한글에서 다른 이름으로 저장하거나 변환기를 써야 한다.

---

## 2. 라이브러리 현황

### 2-1. HWPX 읽기/쓰기
| 이름 | 언어 | 범위 | 성숙도/최근 | 라이선스 |
|---|---|---|---|---|
| **python-hwpx** (airmang) (18, 19) | Python 3.10+ | HWPX 읽기·편집·생성·검증. 문단, 스타일(이름으로 지정), 표(라벨로 셀 찾아 채우기 `tables.fill_by_path`), 머리말/꼬리말, 메모, 각주, 이미지, 목차, 메일머지, redline. MD/HTML 내보내기. **HWP 5.0도 같은 API로 열고 .hwp로 저장한다고 주장**(변환 손실은 conversion_report에 기록). 수정하지 않은 부분은 바이트 그대로 보존 | Alpha(API 변동 가능), v2.9.1(2026-04)를 거쳐 5.x대, 커밋 1,347개, 별 117개, 누적 다운로드 약 24만. 실제 한컴 12.0에서 열리는지 회귀 테스트 기록이 있다 | Apache-2.0 |
| **HwpForge** (Rust, Python 래퍼 `hwpforge`) (20, 21) | Rust/Python | HWPX 읽기/쓰기, MD↔HWPX, JSON, 템플릿과 restyle 프리셋, fill/set_cell/patch(불변 객체), HWP5→HWPX 단방향, PDF(저장된 레이아웃이 있을 때만). CLI와 MCP 동일 기능 | 0.16.11(2026-10-13), 활발 | MIT OR Apache-2.0 |
| **hwpxlib / hwplib / hwp2hwpx** (neolord0) (22) | Java | hwplib: HWP 5 읽기/쓰기. hwpxlib: HWPX 읽기/쓰기. hwp2hwpx: 변환 | 오래되고 안정적. hwplib 1.1.10. .NET 포트(HwpLibSharp)도 있다 | Apache-2.0 |
| **rhwp** (edwardkim) (23) | Rust+WASM | HWP5/HWPX 파싱, **렌더링(SVG/PNG/PDF/Canvas)**, 웹 에디터, HWP 편집 저장, HWPX 저장(의미 보존 목표), CLI(export-svg/png/pdf, dump), MCP(`mcp-serve`), VS Code 확장, macOS arm64 바이너리 | 별 약 4,000개, 커밋 1.4만 개, v0.8.x, 매우 활발 | MIT |
| hwpx-js (npm) (6) | JS | HWPX 읽기 위주 [추정] | 0.1.2, 초기 | 미확인 |
| Dayoooun/hwpx-mcp 내부 구현 (24) | TS/Node | MCP에 내장된 HWPX 편집기 | 아래 3장 참조 | MIT |

### 2-2. HWP 5.0 바이너리 읽기
| 이름 | 언어 | 비고 |
|---|---|---|
| pyhwp (hwp5) (25) | Python | 읽기 전용(hwp5proc, hwp5html, hwp5odt). AGPLv3. PyPI 마지막 기록이 0.1b12(2019)여서 사실상 정체 상태다 |
| syhwp (26) | Python 3.9–3.13 | 순수 Python HWP/HWPX 리더, text/MD/HTML 출력. pyhwp의 AGPL을 피하려고 만든 것 |
| hwp.js (hahnlee) (27) | JS | HWP 5.0 뷰어/파서, Apache-2.0, 유지보수 상태는 미확인 |
| @ohah/hwpjs (27) | Rust 코어+JS | JSON/MD/PDF 변환 CLI, RC 단계 |
| hwpers (28) | Rust | HWP 5.0 파싱, SVG 내보내기 |
| hwplib (22) | Java | **HWP 5 쓰기도 가능한 몇 안 되는 라이브러리** |
| rhwp (23) | Rust | 읽기, 렌더링, 편집 저장까지 |
| python-hwpx (19) | Python | 열기/저장(.hwp) 지원을 주장. 실제 품질은 검증 필요 [추정] |

- HWP 쓰기는 hwplib(Java), rhwp, python-hwpx(주장), 한컴 COM/SDK 정도만 가능하다. **새로 만드는 프로젝트에서 HWP 쓰기는 범위 밖으로 두는 것이 맞다.**

### 2-3. 변환 도구
- **hwp2md** (Rust, 0.5.0, 2026-05, GPL-3.0) (29): HWP5/HWPX→MD와 MD→HWPX 양방향. 병합 셀이 있는 표는 HTML로 내보내고, 각주는 양방향 모두 지원한다. MD→HWPX 스타일은 YAML 템플릿(`--style`)으로 지정한다. 단 GPL이라 라이브러리로 링크하기 어렵고 CLI로 호출해 써야 한다.
- **pypandoc-hwpx** (msjang) (30, 31): DOCX/MD/HTML→HWPX. `--reference-doc=custom.hwpx`로 **참조 HWPX의 스타일과 용지 설정을 복제**한다. Pandoc 생태계에 기댄다. 작성자는 Pandoc에 HWPX writer를 기여할 계획을 밝혔다.
- md2hwp (npm) (9): MD→HWP. 줄 배치(lineseg) 문제를 분석한 문서가 유용하다.
- Obsidian 플러그인 HWPX Writer (30): 한글에서 다듬은 템플릿 파일을 등록하면 그 스타일을 복사해 쓴다.
- **LibreOffice**: 기본 탑재된 HWP 필터는 오래된 HWP 97 계열용이다 [추정]. HWP5/HWPX는 확장 **H2Orestart**(GPL, Java)로 읽기만 되고 저장은 ODT로만 된다 (32). LibreOffice 본체에 HWPX 필터를 넣으려는 작업과 KS X 6101 번역 요청이 진행 중이다 (3). 현재 출시 여부는 확인하지 못했다.

### 2-4. 맥에서 결과물을 시각적으로 확인하는 방법
| 방법 | 편집 | 자동화 | 비고 |
|---|---|---|---|
| 한컴오피스 한글 for Mac (유료, 한컴독스 구독판도 설치형 제공) (16) | O | AppleScript/CLI 자동화 정보는 찾지 못했다 [추정]. Dayoooun/hwpx-mcp가 "macOS에서는 Hancom for Mac으로 PDF 내보내기"를 지원한다고 적고 있어 어떤 방식으로든 가능해 보인다 (24) | 실제 레퍼런스 렌더러. 최종 확인용 |
| 한컴오피스 한글 Viewer (Mac App Store, 무료) (33) | X | X | 사람이 눈으로 확인 |
| 한컴독스 웹/앱 (무료 2GB, 개인 구독) (34) | O | X | 업로드가 필요해서 회사 문서는 보안상 주의 |
| **rhwp CLI** `export-png/pdf/svg` (23) | - | **O** | 맥 네이티브 바이너리. AI가 결과물을 이미지로 보고 스스로 검증하는 루프를 만들 수 있는 유일한 무료 선택지. 다만 한컴과 100% 같지는 않다 |
| HOP (golbin, rhwp 기반 맥 앱, v0.1.5, 2026-04) (35) | 일부 | X | HWPX 저장 불가, 초기 단계 |
| LibreOffice+H2Orestart→PDF (32) | - | O(headless) | 충실도는 rhwp보다 낮을 것으로 보인다 [추정] |

---

## 3. 기존 AI 연동 사례

| 프로젝트 | 접근 | 형태 | 평판/특징 |
|---|---|---|---|
| jkf87/hwp-mcp (36, 37) | Windows COM(pywin32) | MCP | 원조 격. 변경 기록이 2025-03에서 멈췄다. 사용자가 이전에 시도한 방식과 같은 계열 |
| treesoop/hwp-mcp (npm), hwp-mcp(PyPI) (38) | 파일 직접 | MCP | HWP 읽기, HWPX 읽기/치환/생성 |
| **Dayoooun/hwpx-mcp** (24) | 파일 직접(Node). PDF만 한컴 엔진 | MCP, 77~132개 도구 | mjyoo2/hwp-extension에서 갈라져 나왔다. MIT, 별 34개. 도구 수가 많은 "잘게 쪼갠 API" 형태이고, 경로 제한이 없는 보안 이슈가 있다 |
| airmang/hwpx-mcp, hwpx-mcp-server (python-hwpx 기반) (39, 40) | 파일 직접 | MCP(stdio, Smithery HTTP) | 77개 도구. python-hwpx 작성자 쪽 생태계 |
| **canine89/hwpxskill** (10, 41) | **XML 직접(unpack→편집→pack)** | **Claude 스킬+스크립트** | 별 326개. Anthropic docx 스킬과 같은 구조. gonmun/report/minutes/proposal 템플릿과 slot 추출→채우기, finalize(lineseg 제거), page_guard/content_guard, gonmun_lint(공문 표기 검수)를 갖췄다. 사용자가 세운 가설에 가장 가까운 레퍼런스 |
| **jkf87/hwpx-skill** (42) | XML 직접+JSON 원샷 스펙 | Claude/Codex 스킬 | 별 288개, v1.10. 공문(gonmun), 보도자료, 계획서 생성기. 플레이스홀더 미매칭이면 실패시키는 preflight, HWP→HWPX 변환(COM 우선, rhwp WASM 대체)을 제공한다. 정적 검사와 실제 페이지 검토를 분리하는 원칙을 따른다 |
| moonklabs gov-apply hwp-format (8) | python+hwp2hwpx(Java) | 플러그인 스킬+MCP | 정부 양식의 `○○○○`, `( )` 빈칸 패턴을 채운다. 복잡한 양식은 MD 초안으로 대체한다 |
| rhwp `mcp-serve` (23) | 자체 엔진 | MCP | 읽기, 검색, 채우기, 변환 |
| pypandoc-hwpx (31) | Pandoc AST→HWPX | CLI | GeekNews에서 반응이 좋았다. 댓글에서는 역방향(HWP→MD) 수요가 더 크다는 의견이 나왔다 |

- 흐름: 2025년 초까지는 COM 방식 MCP가 주류였다. 2026년에는 **파일 직접 처리와 스킬(스크립트 동봉) 방식**이 주류로 바뀌었다. 성공한 스킬들의 공통점은 ① 템플릿과 slot 기반 채우기 ② 저장 후 검증 게이트 ③ lineseg 캐시 정리 ④ 렌더링으로 사람이나 AI가 확인하는 단계를 분리한 것이다.
- 한컴 자체: 한컴어시스턴트(2024-12 정식 출시, 한컴오피스와 한컴독스에 내장, LLM/sLLM 연동), 한컴 데이터로더(문서 구조 추출), 한컴피디아(RAG) (4, 43). **외부 개발자용 공개 API나 MCP는 확인하지 못했다.** B2B 공급이 중심이다 (44).

---

## 4. 설계 판단 근거

### 4-1. 템플릿 채우기 난이도
| 대상 | 난이도 | 근거와 방법 |
|---|---|---|
| 플레이스홀더 텍스트(`{{이름}}`, `○○○`) | 낮음 | `hp:t` 치환. 단 한글이 텍스트를 run 여러 개로 쪼개 저장하는 경우가 있다 [추정]. 한 run 안에 들어 있는지 정규화해야 한다 |
| 표 셀(라벨 옆 칸 채우기) | 중간 | python-hwpx `fill_by_path`처럼 라벨로 찾는 방식이 실용적이다 (19). 병합 셀(cellSpan)과 중첩 표가 있으면 셀 주소가 어긋난다. 행 추가는 원래 행의 서식을 복제해야 한다 |
| 누름틀(필드) | 중간 | COM에서는 `%clk` 컨트롤이다 (45). HWPX에서는 `hp:fieldBegin`(type=CLICK_HERE, name)부터 `hp:fieldEnd`까지의 구간으로 보인다 [추정, 공식 스키마 확인 못 함]. 이름이 있어 슬롯 매핑에는 가장 깔끔하다. 다만 실제 공문 양식에 누름틀이 있는 경우는 드물 것으로 보인다 [추정] |
| 스타일 | 낮음~중간 | 기존 charPr/paraPr/style ID를 **재사용만** 하면 안전하다. 새로 만들면 header.xml의 itemCnt와 ID 무결성을 맞춰야 한다 (10의 fix_namespaces) |
| 분량 변화로 인한 레이아웃 | 높음 | 공문은 1쪽 고정인 경우가 많다. 글이 넘치면 쪽이 밀린다. hwpxskill의 page_guard처럼 "글자 예산"을 미리 검사하고, 렌더링으로 확인해야 한다 |

### 4-2. md→HWPX 스타일 적용 방법
1. **참조 문서 방식(권장)**: 사람이 한글에서 다듬은 `report-template.hwpx`의 header.xml을 그대로 쓴다. MD의 h1~h3, 본문, 목록, 표를 템플릿의 **스타일 이름**(예: "개요 1", "본문")에 매핑하고 section XML만 새로 만든다. pypandoc-hwpx의 `--reference-doc`, HwpForge의 templates, Obsidian HWPX Writer가 이 방식이다 (20, 30, 31).
2. YAML 스타일 정의(hwp2md `--style`) (29): 코드로 header를 만든다. 사람이 만든 회사 양식을 재현하기 어렵다.
3. 원칙: 템플릿에 **없는 서식은 만들지 않는다.** 필요한 스타일 목록을 템플릿 계약으로 고정한다.

### 4-3. 어려운 요소
- **복잡한 표**: 병합과 중첩, 셀별 borderFill, 셀 안의 여러 문단. MD 표로는 병합을 표현할 수 없어 hwp2md도 HTML로 우회한다 (29). 보고서 생성에서는 단순 표만 허용하고, 복잡한 표는 템플릿 안의 표를 채우는 방식으로 처리하는 것이 현실적이다.
- **각주/미주**: run 안의 컨트롤에 하위 문단 목록을 넣는 구조다 [추정]. python-hwpx와 hwp2md가 지원하므로 직접 구현하지 않는다 (19, 29).
- **개요번호**: header.xml의 numbering(개요 수준별 형식 "1.", "가.", "1)")과 문단의 heading 속성으로 연결된다 [추정]. 공문은 "1. 가. 1) 가)" 체계를 쓴다. MD의 `#`/목록 깊이를 템플릿의 "개요 n" 스타일에 매핑하면 번호는 한글이 자동으로 매긴다. 번호를 텍스트로 직접 박지 않는다.
- **lineseg 캐시**: 텍스트를 바꾼 모든 문단에서 지운다 (9).
- **글꼴**: 맥에 한컴 글꼴(함초롬 등)이 없으면 rhwp/HwpForge 렌더링 결과가 달라지거나 실패한다 (20).

---

## 5. 결론

### 5-1. 추천 스택
- **언어: Python.** python-hwpx(Apache-2.0)가 가장 성숙하다. HWPX 편집/생성/표 채우기/MD 내보내기/검증을 이미 갖췄고, 맥과 CI에서 돌아가며, 실제 한컴에서 열리는지 회귀 테스트한 기록이 있다.
- 보조 도구:
  - rhwp CLI: PNG/PDF 렌더링으로 AI가 스스로 확인. HWP5 읽기의 대체 경로
  - HwpForge: MD→HWPX와 템플릿 비교 후보
  - hwp2md: HWP→MD 품질 비교 기준(GPL이라 별도 프로세스로 호출)
- **라이브러리 vs 직접 XML**: "라이브러리 우선, 막히면 XML 탈출구(unpack/pack)" 혼합 방식을 권장한다. 공문 양식 채우기는 원본 바이트를 보존해야 하므로 XML 최소 패치 방식(hwpxskill 스타일)이 안전하다. md→HWPX 생성은 라이브러리나 템플릿 기반 생성이 낫다.
- 직접 다시 만들기보다 **canine89/hwpxskill, jkf87/hwpx-skill을 먼저 실제 공문/보고서로 돌려 보고** 부족한 점만 보강하는 방식을 검토할 만하다.

### 5-2. MVP 순서
1. **HWP/HWPX→MD 추출**: 가장 쉽고 위험이 낮다. AI가 기존 문서와 양식을 이해하는 입력이 되므로 다른 기능의 토대가 된다. GeekNews에서도 수요가 가장 컸다.
2. **공문 양식 채우기**: 사람이 만든 템플릿에 slot을 추출하고, JSON으로 채운 뒤, lineseg 정리→검증→rhwp PNG 확인 순으로 처리한다. 범위가 좁고 성공 기준이 명확하다.
3. **보고서 md→HWPX**: 참조 템플릿의 스타일에 매핑한다. 개요번호, 표, 각주 처리가 필요해 가장 넓고 어렵다.

### 5-3. 형태
- **Claude Code 스킬(SKILL.md + Python 스크립트 동봉) 우선, 스크립트는 CLI로도 쓸 수 있게** 만든다.
  - 근거 1: 실패 원인이 "잘게 쪼갠 도구와 상태 추적"이었다. 스킬은 작업 단위 스크립트 몇 개와 검증 게이트로 구성되고, AI는 파일 경로만 다룬다.
  - 근거 2: 2026년에 성공한 사례(hwpxskill, hwpx-skill)가 이 형태다. Anthropic docx/pptx 스킬과 같은 패턴이다.
  - 근거 3: 별도 서버를 띄울 필요가 없다.
- MCP는 나중에 Claude Desktop/ChatGPT 같은 비CLI 클라이언트를 지원할 때 같은 CLI를 감싸는 얇은 래퍼로 붙인다(python-hwpx-automation, HwpForge가 이 방식) (19, 20).

### 5-4. 주요 리스크와 대응
| 리스크 | 대응 |
|---|---|
| ① 한글에서 열리지 않거나 레이아웃이 깨짐(lineseg, itemCnt, 네임스페이스, mimetype 순서) | 원본 바이트 보존 패치, 저장 후 validate→finalize 게이트, 실제 한글 파일을 회귀 테스트 fixture로 사용. 최종 확인은 한글 Viewer(무료)나 Mac 한글로 한다 |
| ② 맥에 신뢰할 수 있는 렌더러가 없어 AI가 결과를 확인하지 못함 | rhwp CLI의 PNG 내보내기로 자동 확인 루프를 만든다(근사치). 한컴 글꼴을 설치한다. 최종 품질 판정은 사람이 Viewer로 하는 단계로 명시한다 |
| ③ 공개 스펙이 없고 라이브러리가 Alpha 상태여서 API가 바뀌고 미지원 요소가 나옴(병합 표, 누름틀, 개요번호) | 라이브러리 버전을 고정한다. 템플릿 계약(지원 스타일과 요소 목록)으로 범위를 제한한다. 미지원 요소는 XML 탈출구로 처리한다. 회사 실제 양식 3~5종을 골든 샘플로 쓴다 |
| (추가) 회사 문서 보안 | 한컴독스 웹이나 Smithery 원격 MCP처럼 외부로 업로드하는 경로를 쓰지 않는다. 로컬 처리만 한다 |

---

## 출처
1. 한컴 문서 형식 공개 페이지 — https://store.hancom.com/etc/hwpDownload.do
2. PRONOM fmt/1084 — https://www.nationalarchives.gov.uk/PRONOM/fmt/1084
3. LibreOffice Ask: KS X 6101 번역 요청(Bug 165215) — https://ask.libreoffice.org/t/call-for-translators-to-help-bug-165215-fixed/118797 (본문 접근 차단, 검색 요약 기준) / 발표자료 https://speakerdeck.com/studioego/ubucon-korea-2023-hangugyi-munseo-pyojungwa-libreoffice-hangugeo-keomyuniti-hwaldong-sogae
4. 아이뉴스24 KCSF2025 한컴 — https://www.inews24.com/view/1892549
5. HWPX 개념잡기(노션) — https://archive-ssu.notion.site/5-HWPX-299760c1e3964a8d8212118c24a78ad2
6. hwpx-js README — https://cdn.jsdelivr.net/npm/hwpx-js@0.1.2/README.md
7. Dayoooun create-sample-hwpx.js — https://glama.ai/mcp/servers/@Dayoooun/hwpx-mcp/blob/87850fd67f0488d79fcbf061a29938cae914a15d/scripts/create-sample-hwpx.js
8. moonklabs gov-apply hwp-format — https://www.claudepluginhub.com/skills/moonklabs-moonklabs-gov-apply-gov-apply/hwp-format
9. md2hwp Line Wrapping Fix — https://cdn.jsdelivr.net/npm/md2hwp@1.2.7/docs/Line_Wrapping_Fix.md
10. canine89/hwpxskill — https://github.com/canine89/hwpxskill
11. hancom-io GitHub — https://github.com/hancom-io
12. hwpx-owpml-model — https://github.com/hancom-io/hwpx-owpml-model
13. 한컴 Hwp SDK — https://hancom.com/en/product/sdk/hwpSdk
14. 한컴 개발자 페이지 — https://recruit.hancom.com/en/service/developer
15. 바이라인 2021-04 HWPX 기본 저장 — https://byline.network/2021/04/15-117/
16. 바이라인 2023-12 맥용 한글 — https://byline.network/2023/12/1218_005
17. 바이라인 hwp 태그(2026-04-23 첨부 제한, ChatGPT/Gemini 지원) — https://byline.network/tag/hwp/
18. python-hwpx GitHub — https://github.com/airmang/python-hwpx
19. python-hwpx README — https://raw.githubusercontent.com/airmang/python-hwpx/main/README.md / 다운로드 수 https://pepy.tech/project/python-hwpx
20. hwpforge PyPI — https://pypi.org/project/hwpforge/
21. hwpforge docs.rs — https://docs.rs/hwpforge
22. hwplib — https://github.com/neolord0/hwplib , Maven https://central.sonatype.com/artifact/kr.dogfoot/hwplib , hwp2hwpx https://github.com/neolord0/hwp2hwpx
23. rhwp — https://github.com/edwardkim/rhwp
24. Dayoooun/hwpx-mcp — https://github.com/dayoooun/hwpx-mcp
25. pyhwp — https://pyhwp.readthedocs.io/ , https://pypi.org/project/pyhwp/0.1b14
26. syhwp — https://pypi.org/project/syhwp/
27. hwp.js — https://redirect.github.com/hahnlee/hwp.js , @ohah/hwpjs https://cdn.jsdelivr.net/npm/@ohah/hwpjs@0.1.0-rc.10/README.md
28. hwpers — https://docs.rs/crate/hwpers/latest
29. hwp2md — https://docs.rs/crate/hwp2md/latest
30. Obsidian HWPX Writer — https://community.obsidian.md/plugins/hwpx-writer
31. pypandoc-hwpx — https://github.com/msjang/pypandoc-hwpx , GeekNews https://news.hada.io/topic?id=25186 , 위키독스 https://wikidocs.net/blog/@jaehong/9923/
32. H2Orestart — https://extensions.libreoffice.org/en/extensions/show/27504 , Debian https://tracker.debian.org/media/packages/h/h2orestart/control-0.7.14-1
33. 한컴오피스 한글 Viewer(Mac) — https://apps.apple.com/kr/app/%ED%95%9C%EC%BB%B4%EC%98%A4%ED%94%BC%EC%8A%A4-%ED%95%9C%EA%B8%80-viewer/id416746898?mt=12
34. 한컴독스 앱/비교 — https://apps.apple.com/us/app/%ED%95%9C%EC%BB%B4%EB%8F%85%EC%8A%A4-%EC%98%A4%ED%94%BC%EC%8A%A4/id1611732182?l=ko , https://yellowit.co.kr/it-review/hancom-office-2024-download-docs-free-viewer-install/
35. HOP 소개 — https://extrememanual.net/59922 , https://github.com/golbin/hop
36. jkf87/hwp-mcp 구조 — https://glama.ai/mcp/servers/@jkf87/hwp-mcp/blob/main/hwp-mcp-구조설명.md
37. mcpservers.org jkf87/hwp-mcp — https://mcpservers.org/servers/jkf87/hwp-mcp
38. hwp-mcp PyPI — https://pypi.org/project/hwp-mcp/ , treesoop https://thedailyworkflow.com/ru/mcp/server/hwp-mcp
39. airmang hwpx-mcp — https://www.getdrio.com/mcp/ai-smithery-airmang-hwpx-mcp , https://claudemarketplaces.com/mcp/ai.smithery/airmang-hwpx-mcp
40. python-hwpx 기반 MCP — https://glama.ai/mcp/servers/emxwg1fqsn
41. skills.sh hwpxskill — https://skills.sh/canine89/hwpxskill/hwpx
42. jkf87/hwpx-skill — https://github.com/jkf87/hwpx-skill
43. 한컴독스 AI(CIO) — https://www.cio.com/article/3542389/ , 디지털데일리 https://m.ddaily.co.kr/page/view/2024120609084433635
44. 비즈워치 2026-06 한컴어시스턴트 공급 — https://news.bizwatch.co.kr/article/mobile/2026/06/29/0024
45. 인프런 누름틀 제거 Q&A — https://www.inflearn.com/community/questions/1116683/특정-누름틀-필드-제거

---

## 핵심 결론 5줄
1. HWPX는 2021년(Windows)과 2023년(Mac)부터 한글의 기본 저장 형식이고, 2026년 정부가 .hwp 첨부를 제한하기 시작했다. "파일 직접 처리" 방향은 맞다. 다만 쓸 만한 공개 스펙은 없으므로, 한글이 실제로 저장한 샘플과 오픈소스 코드를 레퍼런스로 삼는다.
2. 스택은 Python + python-hwpx(Apache-2.0)가 중심이다. 렌더링 확인과 HWP5 처리는 rhwp CLI(MIT)에 맡기고, 원본 양식을 보존해야 하는 편집은 unpack→XML 최소 패치→pack 탈출구를 함께 쓴다.
3. 형태는 MCP보다 Claude Code 스킬(SKILL.md + 작업 단위 스크립트 + 검증 게이트)이 낫다. 2026년에 성공한 사례(canine89/hwpxskill, jkf87/hwpx-skill)가 이 형태다. 직접 만들기 전에 이 둘을 회사 양식으로 먼저 돌려 본다.
4. MVP 순서: ① HWP/HWPX→MD 추출 ② 공문 템플릿 slot 채우기 ③ 참조 템플릿 스타일 기반 보고서 md→HWPX.
5. 핵심 리스크는 한글에서 열리지 않거나 레이아웃이 깨지는 것(lineseg 캐시 등), 맥에서 렌더링 확인이 어려운 것, 라이브러리가 Alpha이고 미지원 요소가 있는 것이다. 각각 검증·finalize 게이트, rhwp PNG와 한글 Viewer 확인, 버전 고정·템플릿 계약·골든 샘플로 대응한다.
