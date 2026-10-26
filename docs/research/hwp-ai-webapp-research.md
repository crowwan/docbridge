# 조사 완료: 비개발자용 "한글 문서 + AI" 웹앱 (rhwp WASM 기반)

조사일: 2026-10-23 / 선행 보고서(`hwpx-automation-research.md`)와 겹치는 HWPX 포맷·python-hwpx·lineseg 기본 설명은 생략함
표기: [추정] = 직접 확인 못 함, (n) = 하단 출처 번호

---

## 0. 요약 한 장

| 질문 | 답 |
|---|---|
| rhwp로 브라우저 안에서 미리보기 + 편집 + HWPX 저장이 되나 | **된다.** npm `@rhwp/core`(WASM 파서·렌더러·편집 API 473개, `exportHwpx`)와 `@rhwp/editor`(iframe 에디터)가 0.8.7(2026-10-06)까지 배포돼 있다. MIT |
| 품질은 | 렌더링은 한컴 PDF와 비교하는 대규모 회귀 체계가 있지만 아직 v1.0 전이다. HWPX 저장 후 한컴에서 "문서 변조" 오류가 나거나 버전 간 쪽 배치가 퇴행하는 이슈가 열려 있다. **버전 고정과 저장 결과 직접 확인이 필수**다 |
| 경쟁 | 한컴독스 AI(웹, 월 4~7천 원), 한컴어시스턴트(한글 2024 플러그인), 인라인AI(한글 플러그인), 엘리스스쿨 헬피챗(교사용, HWP 첨부→AI 수정→미리보기→다운로드), 세종 AI(크롬 확장). ChatGPT·Gemini는 HWP를 **읽기만** 한다. 개발자 도구(kordoc, claw-hwp, hwp-mcp)는 많지만 비개발자가 쓰기는 어렵다 |
| 비어 있는 자리 | "**설치·업로드 없이, 맥/윈도우 아무 브라우저에서, 받은 양식의 칸을 AI가 채우자고 제안하고 사람이 하나씩 승인해서, 원본 서식 그대로 HWPX로 받는**" 도구. 한컴 계열은 업로드(클라우드)나 한컴오피스 설치가 전제이고, 범용 AI는 HWPX를 돌려주지 못한다 |
| 결론 | 조건부 GO. 주말 PoC에서 "실제 양식 10종 → 채우기 → 한글에서 깨짐 없이 열림"이 통과하면 진행 |

---

## 1. rhwp 심층

### 1-1. 레포와 배포 형태 (1, 2, 3)
- `edwardkim/rhwp`: 별 3,989, 포크 780, 열린 이슈 363개, 2026-03-27 공개, 2026-10-23에도 push. Rust 1.93 + wasm-pack(Docker 빌드). README 기준 45만 줄 이상, Rust 테스트 3,400개 이상, studio 단위·e2e·시각 회귀 CI.
- 레포 안에 엔진(`src/`), 웹 에디터(`rhwp-studio`, TS+Vite), 확장 프로그램(Chrome/Edge/Firefox/Safari/VS Code), iOS·데스크톱 셸, `npm/editor` 패키지가 함께 있다.
- **npm 배포**
  | 패키지 | 버전 | 크기 | 용도 |
  |---|---|---|---|
  | `@rhwp/core` | 0.8.7 (2026-10-06) | 압축 해제 12.5MB. `rhwp_bg.wasm` **11.8MB → gzip 4.4MB / brotli 3.1MB**(직접 측정), `rhwp.js` 450KB, `rhwp.d.ts` 180KB | WASM 파서·렌더러·편집 API |
  | `@rhwp/editor` | 0.8.7 | 80KB (SDK만). 실제 에디터는 iframe으로 띄우는 rhwp-studio | 메뉴·툴바까지 갖춘 에디터 임베드 |
- 웹폰트 자산: OFL 계열 WOFF2 36개, 합계 22.6MB(`assets/fonts`) (4). 전부 받지 않고 필요한 것만 지연 로드하도록 설계해야 한다 [추정: studio가 필요한 폰트만 로드하는지는 확인 못 함].
- CLI 바이너리(맥 arm64 포함)와 `mcp-serve`도 릴리스마다 배포한다.

### 1-2. 브라우저 임베드 방법 (2, 3)
- **A. `@rhwp/core` 직접 사용**: `globalThis.measureTextWidth`(Canvas `measureText` 콜백)를 **초기화 전에 반드시 등록**하고, `init({module_or_path:'/rhwp_bg.wasm'})` 다음 `new HwpDocument(Uint8Array)`로 연다. 그 뒤 `renderPageSvg(i)` 또는 `renderPageToCanvas(...)`로 그린다. 파일은 브라우저 메모리에서만 처리되므로 서버 업로드가 없다.
- **B. `@rhwp/editor`**: `createEditor('#el')` 세 줄로 붙인다. 기본 `studioUrl`이 `https://edwardkim.github.io/rhwp/`이라 **그대로 쓰면 제3자 origin의 iframe에 문서를 넘기는 구조**가 된다(처리는 여전히 클라이언트에서 한다). 안정성과 신뢰를 위해 studio를 **직접 호스팅**하는 것이 맞다. `file:`/opaque origin은 지원하지 않는다.
  - `createStudio` + `plugins:['hwpctrl']`로 한컴 웹기안기 호환 HwpCtrl API(`PutFieldText` 등)를 배치 트랜잭션으로 호출할 수 있다. 100회 호출 기준 배치 11ms, 개별 583ms(약 45배 차이).
  - **문서 에이전트 exact command**(`getDocumentState`/`getSelectionContext`/`applyTextCommand`/`revertTextCommand`/`focusTarget`)가 이미 있다. 문서 epoch, 변경 순번, 문서 SHA, 대상 원문·서식·인접 문맥 SHA를 모두 묶어 **문단 1개를 교체**하고 되돌린다 (5). 이번 구상의 "AI 제안 → 적용/취소"와 거의 같은 계약이다. 다만 v1은 **본문 문단만** 지원한다(표 셀, 머리말, 각주, 글상자, 필드나 혼합 서식이 있는 문단은 제외). 양식 채우기의 핵심인 표 셀은 아직 대상이 아니다.
- 권장: MVP는 A(core)로 직접 렌더링하고 편집 명령을 붙인다. 화면을 직접 제어할 수 있고, AI 패널과 하이라이트를 자유롭게 겹칠 수 있다. 사용자가 손으로 고칠 일반 편집은 나중에 B(직접 호스팅한 studio)로 확장한다.

### 1-3. 렌더링 품질과 알려진 한계
- **조판 방식**: 레이아웃은 Rust에 내장된 **폰트 메트릭 DB**(함초롬·HY·한컴 계열 글자 폭 수치)로 계산한다. 글리프는 OFL 대체 폰트로 그린다. 그래서 한컴 폰트가 없어도 **줄바꿈과 쪽 나눔은 원본 메트릭 기준**으로 맞추려 하고, 글자 모양만 달라진다 (4, 6). DB에 없는 폰트는 기본 폭으로 계산되어 글자가 겹치는 증상이 날 수 있다 (6).
- **검증 체계**: 한글 2022 PDF를 정답 캐시로 두고 HWPX 3,418건을 스윕했다. "저장 사다리 대비 쪽 안 드리프트" 242건(약 7%)이 남아 개선 캠페인을 진행 중이다 (#4599) (7). 메인테이너는 "한컴 PDF도 도구·버전·출력 경로마다 달라 정답지가 아니다"라고 명시한다 (1).
- **현재 열린 품질 이슈 예시** (8)
  - #7219 표 안에 이미지를 넣고 HWPX로 저장하면 **한컴 데스크톱에서 "문서 변조" 오류로 열리지 않음**(0.8.4, 열림)
  - #7626 0.8.6~0.8.7에서 linesegarray가 있는 공문 서식이 2쪽에서 1쪽으로 합쳐지는 **퇴행**(0.8.4는 정상, 종결)
  - #7857 0.8.7 저장 vertpos 되감김 퇴행(열림), #6907 content.hpf 항목 순서를 다시 써서 바탕쪽 소속이 사라짐(열림), #7528 머리말의 쪽 번호 필드가 저장 후 사라짐(열림)
  - 시사점: **버전을 고정하고 업그레이드할 때마다 골든 샘플로 회귀 검사**해야 한다. 이 이슈를 올린 쪽 중에 "ChunkLab·AI-HUB 자체 호스팅으로 rhwp-studio를 임베드"한 사례가 있어, 같은 방향을 시도하는 팀이 이미 있다는 신호다 (8).

### 1-4. 편집 API 범위 (`rhwp.d.ts` 직접 분석) (3)
- 메서드 473개. 이번 구상에 필요한 것만 추리면 다음과 같다.
  | 목적 | API |
  |---|---|
  | 구조 읽기 | `getStructure(mode)`(개요/조문 트리), `getOutlineNavigation`, `getParagraphCount`, `getPageText`, `getTextFileUnicode`, `getScanItems`, `getControls`, `getTableDimensions(ByPath)`, `getTableCellBboxes(ByPath)`, `getTextInCellByPath`, `getFieldList()`(누름틀: name/guide/value/location), `getCharShapeRuns`, `getDocumentInfo`, `getValidationWarnings`(LinesegUncomputed 등) |
  | 텍스트 수정 | `replaceText(sec,para,off,len,text)`, `replaceOne/replaceAll`(검색 기반), `insertText`, `deleteText`, `insertTextInCellByPath`, `deleteTextInCellByPath`, `setFieldValueByName`(누름틀 채우기) |
  | 표 구조 | `insertTableRow/Column`, `deleteTableRow`, `mergeTableCells`, `splitTableCell` 등 |
  | 트랜잭션/되돌리기 | `beginBatch/endBatch`, `saveSnapshot/restoreSnapshot/discardSnapshot` |
  | 저장 | `exportHwpx()`, `exportHwpxWithReport()`(**content-loss 보고서 JSON 포함**), `exportHwp()`, `exportHwpVerify()`(재로드 검증) |
  | 줄 배치 | `reflowLinesegs()`(사용자가 명시적으로 요청할 때 전체 재계산) |
  | 폰트 | `setFontEnvironment`, `registerExactFontSource`, `getFontDecisionTrace` |
- 0.x 단계라 시그니처가 바뀔 수 있다. 인자가 많은 API는 `*Ex(optionsJson)` 변형을 쓰라고 권한다.

### 1-5. HWPX 직렬화와 lineseg 처리 (9)
- `src/serializer/hwpx/section.rs`를 직접 읽어 확인한 원칙:
  - IR에 원본 lineseg가 있고 위치 축이 온전하면 **원본 값을 그대로 출력**한다(#177).
  - lineseg가 비어 있거나, 줄 전체를 rhwp가 조판용으로 합성한 경우(bit31 표시), 또는 위치 축이 무너진 문단이면 **`linesegarray` 출력을 생략**한다. 그러면 한글이 열 때 다시 계산한다(#1380, #4778, #5847). 코드 주석에는 "어긋난 lineseg를 만나면 한글 2022가 그 문단부터 문서 끝까지 본문을 통째로 버린다(-112,075자 실측)", "누적 좌표가 나가면 81쪽이 5쪽이 된다" 같은 실측 기록이 남아 있다.
  - 즉 rhwp는 lineseg 함정을 알고 있고 "모르면 생략" 전략을 쓴다. **편집한 문단의 lineseg가 실제로 생략되는지는 PoC에서 저장 결과 XML을 열어 확인**해야 한다 [추정: 편집 후 reflow가 합성 표시를 남겨 생략될 것으로 보이나 직접 실행해 보지는 않음].
- 별도 우회 사례: `treesoop/hwp-mcp`는 "rhwp 0.7.7의 `exportHwpx` 라운드트립 한계를 우회하려고 `.hwpx` ZIP 수준 mutation 레이어"를 따로 만들었다 (10). 전체 재직렬화 대신 **원본 바이트 보존 최소 패치**를 택한 것이다.

### 1-6. 글꼴
- 한컴·HY·MS 폰트는 rhwp 레포에 들어 있지 않다(재배포 불가로 판단). 웹에서는 다음처럼 대체한다 (4, 6).
  | 원본 | 대체(웹) |
  |---|---|
  | 함초롬바탕, 한컴바탕, 바탕, 신명조 계열 | Noto Serif KR → 나눔명조 → serif |
  | 함초롬돋움, 맑은 고딕 | Pretendard → Noto Sans KR |
  | 한컴돋움, 돋움, 굴림 | Noto Sans KR(ExtraLight로 획 두께 맞춤) |
  | HY헤드라인M | Pretendard Bold |
- **Local Font Access API**로 사용자 PC에 설치된 한컴 폰트를 감지해 쓰는 경로도 있다(로컬 글꼴 감지 안내창). 한컴오피스가 설치된 사용자는 더 비슷하게 보인다 (2, 6).
- **함초롬체 라이선스**: 한컴이 2010년 한컴오피스 2010 공식 글꼴로 "무료 배포"했다는 보도는 있다 (11). 하지만 웹폰트 재배포와 임베딩 허용 범위를 명시한 약관은 찾지 못했다. 한컴오피스 번들 글꼴은 한컴 프로그램 안에서만 쓰도록 제한된다는 보도가 있고 (12), rhwp도 "재배포 불가"로 분류한다 (6). **결론: 함초롬 WOFF2를 웹앱에 직접 넣어 배포하지 않는다.** 메트릭 수치는 rhwp가 이미 갖고 있으므로 레이아웃 정확도에는 영향이 없다.

### 1-7. 라이선스, 메인테이너, 버스 팩터
- MIT. "한컴 공개 문서를 참고해 개발" 고지 문구와 상표 고지가 필요하다 (1).
- 커밋 수: edwardkim 5,023, jangster77 3,997, planet6897 1,574, postmelee 1,020, kevin9327 963 등. 외부 기여자 40명 이상, 공동 유지보수자 2명 (1, 13).
- 로드맵은 "**특정 업무 화면, 로그인, 과금, 서비스는 다운스트림이 맡는다**"고 명시한다 (13). 업스트림이 AI 패널 웹앱을 직접 만들 가능성은 낮다 [추정]. 대신 CLI/MCP/agent command 같은 연결 규약은 계속 강화한다.
- 버스 팩터는 2~3명 수준이다. 다만 MIT라서 포크로 버틸 수 있다. 다운스트림 생태계가 활발하다: HOP(별 1,933), 알한글 macOS(240), hwp-mcp(99), Slack/Mattermost 뷰어, Android/iPad 앱, rhwp-python 등 (14).

### 1-8. rhwp가 못 하는 부분을 메울 브라우저용 대안
| 후보 | 브라우저 가능 여부 | 쓸모 |
|---|---|---|
| **kordoc** (chrisryugj, TS, MIT, 별 2,685, 4.24.1 / 2026-10-21) (15) | **그대로는 불가.** 엔트리가 `fs/promises`, `child_process`, `crypto`, `zlib`, `module`을 정적으로 import한다(직접 확인). 핵심 의존성은 jszip/xmldom/markdown-it/cfb라서 폴리필이나 부분 번들로 이식할 여지는 있다 [추정] | HWP/HWPX를 MD/IR 블록으로 변환. **`HwpxSession.patchBlocks(BlockEdit[])` + `capability()`(text/cell-text/locked)**로 블록 단위 서식 보존 패치. `fillForm`/누름틀, 공문 lint(`lintBlocks`: 블록 id 기반 지적), HWPX 재조판 줄 시작 일치 99.02%(자체 측정). 공무원 출신 개발자가 만들었고 실제 관공서 문서로 검증했다. **설계 레퍼런스로 1순위**이고, 필요하면 Web Worker용 이식을 검토한다 |
| HwpForge (Rust) (16) | npm/WASM 배포 없음. Rust라서 WASM 빌드는 이론상 가능 [추정] | 템플릿 기반 MD→HWPX |
| hwpx-js 0.1.2, hwp.js 0.0.3(2022 정체), @ohah/hwpjs rc(45MB) | 초기 단계이거나 정체 | 추천하지 않음 |
| 자체 최소 패치기 (JSZip + DOMParser) | 가능 | `section*.xml`의 `hp:t`만 바꾸고 해당 문단의 `linesegarray`를 제거한 뒤, mimetype STORED·첫 엔트리 순서를 지켜 ZIP을 재조립. 범위가 좁고(텍스트 교체만) 원본 보존성이 가장 높다 |
- 제안 구조: **미리보기와 구조 읽기는 rhwp, 저장은 두 경로**를 둔다. ① rhwp `exportHwpxWithReport`(content-loss 0일 때만) ② 원본 ZIP 최소 패치. PoC에서 둘 다 한컴에서 열어 보고 안전한 쪽을 기본값으로 정한다.

---

## 2. 경쟁·유사 서비스

### 2-1. 한컴 자체
| 제품 | 형태 | 기능 | 가격·대상 | 비고 |
|---|---|---|---|---|
| **한컴독스 AI** (17, 18) | 웹(웹 한글, 한폼). 2024-09-30 정식 출시 | 주제→초안, 공문서·보고서·보도자료 AI 템플릿, 이어 쓰기, 문체 변경, 맞춤법, 번역, 요약, 문서 탐색 챗봇, 동시 편집 | 개인 월 4,084원(12개월)~6,900원(1개월), 매월 AI 크레딧 3,000. 기업 1인 월 8,250~10,900원. **B2C 가능** | 문서를 한컴 클라우드에 **업로드**해야 한다. 생성형 기능 중심이고, 받은 양식의 칸을 채우는 특화 기능은 확인 못 함 [추정]. 리뷰에서 "대화형 탐색이 100% 정확하지 않다"는 평이 있다 (19) |
| **한컴어시스턴트** (20, 21) | 한글·한셀 2024 데스크톱 내장 | 초안, 요약, 교정, 이어 쓰기, 이미지. 유료는 노션 연동·PC 파일 검색 에이전트 | 2025-06 개인용 출시, 2025-09 구독(프로모션 월 5,500원·연 54,000원, 정가 월 8,900원). 무료는 고급 기능 하루 10회 | 한컴오피스 2024가 필요하다. 폐쇄망 지원은 B2B 공급용 (22) |
- 외부 개발자용 공개 API나 MCP는 없다(선행 보고서 결론과 같음).

### 2-2. 국내 서비스·스타트업
| 서비스 | 형태 | 내용 | 시사점 |
|---|---|---|---|
| **엘리스스쿨 헬피챗** (23) | 교사용 AI 플랫폼(웹) | 교사가 HWP·워드를 첨부하면 AI가 수정하고, 다운로드 전에 **한글 뷰어로 미리보기**. 2026-09 에듀테크코리아에서 공개 | **구상과 가장 비슷한 제품.** 교사 시장에서는 기관 영업을 하는 업체가 이미 선점 중이다. 출력 형식, 가격, 업로드 방식은 확인 못 함 |
| **인라인AI** (24) | 한글 프로그램 연동 AI 비서(2025-04 출시) | 문서 안에서 바로 작성·편집. "전문가·교육자·공직자 23,000명" 주장(블로그) | 한글 설치가 전제다. 채팅에 올린 파일은 CSAP 인증 클라우드에 저장된다고 주장 |
| **세종 AI** (25) | 크롬 확장 | GPT/Gemini/Claude 출력 → 공문서 스타일 HWPX, 기관 템플릿 적용 | 사용자 382~478명, 평점 3.0~3.5. "AI 결과를 HWPX로" 수요가 있다는 증거 |
| 지니워크 (26) | 크몽 판매 프로그램 | 공무원용 HWPX 생성, **BYOK**(공문 1건 약 44원 주장) | BYOK 과금 모델 선례 |
| 쉽다 한글 (27) | 경기교육청 주무관이 만든 무료 도구 | 표 만들기, 공문 목차, 금액 환산 버튼 | 현장 공무원이 직접 만들 만큼 불편이 크다 |
| 전북교육청 서.비서 (28) | 교육청 자체 | 매뉴얼 RAG, 서식 자동 생성 | 공공은 자체 구축 흐름 |
| 로컬독스(Scoopie) (29) | 로컬 처리 문서 AI | "원본을 외부로 보내지 않음" 마케팅 | 프라이버시 포지셔닝 경쟁자 |
| ChunkLab·AI-HUB (8) | rhwp-studio 직접 호스팅 임베드 | 공문 템플릿 처리 [추정: 제품 상세 불명] | rhwp 기반 AI 공공 문서 시도가 이미 있다 |

### 2-3. 범용 AI의 HWP 지원
| AI | 업로드·읽기 | HWP/HWPX 생성·다운로드 | 근거 |
|---|---|---|---|
| ChatGPT | O (2026-04-17 발표, HWP·HWPX) | 확인 못 함(공식 기능 없음 [추정]) | (30) |
| Gemini | O (2.5부터, 3에서 표까지) | 확인 못 함 | (30, 31) |
| Claude | **X** (업로드하면 "지원하지 않는 형식"). MCP·스킬로 우회 | 스킬로 가능(개발자용) | (31, 32) |
| Copilot | X | X | (31, 32) |
| HyperCLOVA X, 뤼튼 | 확인 못 함 | 확인 못 함 | 검색 결과 없음 |
- 정리: 범용 AI는 읽고 요약하는 데서 멈춘다. "**양식을 원본 그대로 두고 칸만 채운 HWPX를 돌려주는**" 기능은 비어 있다. ChatGPT가 언제든 HWPX 출력을 추가할 수 있다는 점은 리스크다.

### 2-4. 개발자용 도구 (비개발자에게는 진입장벽)
- kordoc(2,685★), claw-hwp(187★, "코딩 몰라도 됩니다"를 내세우지만 Claude Code/Codex 설치가 필요), treesoop/hwp-mcp(99★, rhwp 기반), canine89/hwpxskill, jkf87/hwpx-skill, pyhwpxlib(클리앙 글 조회 1만) (10, 14, 15, 33).
- 클리앙 글 댓글에는 "구글 드라이브 엑셀 → 모임 양식 hwpx 여러 개 생성 성공" 같은 실사용 사례가 있다 (33). 수요는 확인되지만 전부 터미널이나 AI 에이전트를 쓸 줄 아는 사람용이다.

### 2-5. rhwp 기반 앱 현황
- HOP(golbin, 별 1,933, mac/win/linux, 서명된 dmg, Homebrew): 열기, HWP 저장, PDF, 인쇄, 파일 연결. **AI 기능 없음** (14).
- 알한글 macOS(240★), 알한글 tauri(win/linux), RHWP Online(Windows 래퍼), HWPPreview(QuickLook), rhwp-slack, hop_android, hwpad(iPad), rhwptopdf(브라우저 전용 PDF 변환) (14).
- **rhwp 위에 "AI 대화 패널 + 구조 단위 제안/승인"을 올린 비개발자용 웹앱은 찾지 못했다.**

---

## 3. 사용자 수요와 페인포인트

### 3-1. 불편 (수집한 근거)
- **형식 강제**: 공공기관, 학교, 정부지원사업 공고 양식이 HWP/HWPX로 배포된다. 공문서 91.1%가 HWP 또는 스캔 PDF라는 2025년 조사가 인용된다 (34).
- **AI와 단절**: "pptx·엑셀은 AI로 되는데 한글은 안 된다"(클리앙) (33). Claude와 Copilot은 업로드 자체를 거절하고, ChatGPT와 Gemini는 읽기만 한다 (31, 32).
- **서식 맞추기 노동**: 엑셀 셀을 하나씩 복사해 한글에 붙여 넣는 인사발령 작업 (35). 표 구조, 머리말, 글머리표, 쪽 번호 설정이 보고서 작업에서 가장 시간이 많이 든다는 템플릿 업체 설명 (35). 한글 1:1 레슨과 "아래한글 파견출장" 같은 크몽 상품이 존재한다는 것 자체가 신호다.
- **맥/비한컴 환경**: 맥에서는 HWP 전용 폰트가 거칠게 보이고, 글꼴이 바뀌면 레이아웃이 어긋나며, 카톡으로 받은 HWP는 열기 어렵다는 반응 (36).
- **현장의 자구책**: 공무원이 직접 kordoc(광진구청 7년 차), 쉽다 한글(경기교육청)을 만들었다 (15, 27).
- 커뮤니티(블라인드, 인디스쿨, 공무원 카페)는 로그인 장벽 때문에 **직접 확인하지 못했다.** 실제 인터뷰나 설문으로 보강해야 한다.

### 3-2. 자주 쓰는 문서 유형 [일부 추정]
| 사용자 | 문서 | AI 채우기 적합도 |
|---|---|---|
| 공무원 | 기안문·공문(1쪽 고정), 결과·계획 보고서(개조식 □ ○ -), 회의록, 보도자료 | 높음(정형). 다만 기관 AI 정책 제약이 있다 |
| 교사 | 가정통신문, 각종 계획서, 결과 보고서, 학급 운영 서식. 생활기록부는 NEIS 입력이라 HWP와 무관 [추정] | 가정통신문과 계획서가 높음. 학생 개인정보는 넣지 말아야 한다 |
| 사무직·소상공인·창업자 | **정부지원사업 신청서·사업계획서**, 입찰 서류, 각종 신청서(표 + 라벨 칸 구조) | **매우 높음.** 기관 AI 정책의 제약이 없고 양식이 HWP로 강제되며, 칸 채우기가 고통스럽다 [추정: 수요 크기는 미검증] |
| 학부모·대학생·일반인 | 주민센터·학교 제출 양식, 과제 | 중간 |

### 3-3. AI 활용 실태와 기관 정책
- 교사: KICE 조사(2,740명, 2026-10 발표)에서 63%가 수업·평가에 생성형 AI를 쓴다. 우려 1·2위는 부정확한 정보와 개인정보 유출이다 (37).
- 직장인: 한국 응답자 기준 생성형 AI를 매일 쓰는 비율이 14%에서 22%로 늘었다(삼일PwC). AI 활용자의 92.9%가 ChatGPT를 쓴다(대한상의) (38).
- 공공 정책
  - 행안부는 정부 업무망 안의 전용 AI 행정지원 서비스를 시범 운영했다(2024~). 국정원은 행정망 내부에 자체 모델을 두는 방향을 제시했다 (39).
  - 민원인 개인정보·민감정보가 포함된 업무에는 생성형 AI가 부적절하다는 입장(2023). 2025-11 공공부문 AI 윤리원칙(안)에 프라이버시 보호가 들어갔다. 2026-06 공공부문 AI 도입·활용 가이드가 나왔다 (40).
  - KISA 「생성형 AI 개발·활용을 위한 개인정보 처리 안내서」(2025-08) (40).
  - 2026-05부터 온나라, 2026-10부터 온메일·공직자통합메일에서 .hwp 첨부를 제한하고 HWPX로 전환한다 (41).
  - 시사점: **공무원이 업무망에서 외부 LLM API를 쓰는 것은 정책상 회색지대이거나 금지**다 [추정: 기관마다 다르고, 망분리 환경에서는 접속 자체가 막힘]. 1차 타깃을 공무원으로 잡으면 막힌다. **개인 PC로 작업하는 교사 업무, 소상공인·창업자, 일반 사무직**이 현실적이다.

---

## 4. AI 측 설계

### 4-1. 문서를 LLM에 구조로 넘기는 방법 (참고 패턴)
| 사례 | 패턴 | 차용할 점 |
|---|---|---|
| rhwp agent exact command (5) | 대상 = `{kind, section, paragraph}`, 원문·서식·인접 문맥 SHA로 결속, 적용 시 영수증과 되돌리기 | **낙관적 동시성 검사**: AI가 제안한 시점의 원문 해시가 지금 문서와 다르면 적용을 거부 |
| kordoc `HwpxSession` (15) | `blocks`(IR) + `capability(i)` = text/cell-text/locked(+사유) + `patchBlocks([{blockIndex, newText} / {cells:[{row,col,text}]}])` | **편집 가능 여부를 미리 판정**해 UI에 잠금을 표시하고, 표는 격자 좌표로 지정 |
| kordoc `lintBlocks` (15) | 블록 id 기준 지적과 블록 안 위치 반환 | 검수 결과도 같은 블록 id 체계로 표시 |
| SuperDoc (42) | `query.match`가 `target`을 돌려주고, `replace({target,text})`/`comments.create` 실행. tracked 모드 | 검색 → target → 변경의 2단계 |
| Word Copilot / Agent Mode (43) | 변경을 Track Changes로 남기고, 수락·거절은 사용자가 한다 | 승인은 사람만 할 수 있음을 원칙으로 |
| Tiptap AI Suggestion (44) | 에이전트 편집을 suggestion으로 띄우고 `acceptSuggestion/rejectSuggestion`, 거절 피드백을 AI에 돌려줌 | 거절 사유를 다음 턴 맥락에 넣음 |

**제안하는 데이터 계약 (MVP)**
- 읽기용 JSON(LLM 입력), 블록 단위
  - `p:{sec}.{para}`: 문단. `text`, `style`(개요 수준), `editable`
  - `c:{sec}.{para}.{ctrl}.{r},{c}`: 표 셀. `text`, **`label`**(같은 행 왼쪽 칸 또는 열 머리글 텍스트), `empty`, `maxChars`(셀 폭과 글자 크기로 추정한 글자 예산), `merged`
  - `f:{name}`: 누름틀. `guide`, `value`
  - 각 블록에 `h`(원문 해시 앞 8자리)
- 수정은 tool call로만 받는다. `propose_edits({edits:[{target, op:"set_text", text, reason}]})`. MVP에서 서식 변경, 행 추가, 삭제는 막는다.
- 앱의 검증 단계: 대상 존재 → 해시 일치 → `editable` → 글자 예산 → 적용 후 다시 렌더링해 **쪽수 변화가 있으면 경고**. 이 단계를 통과한 것만 카드로 띄우고 [적용]/[취소]를 받는다. 적용에는 rhwp `saveSnapshot`/편집 API를 쓰고, 되돌리기는 `restoreSnapshot`을 쓴다.
- 토큰 절약: 처음에는 "빈 칸·라벨 목록"만 보낸다. 본문 전체는 사용자가 요약이나 검토를 요청할 때만 보낸다.

### 4-2. 브라우저에서 LLM 호출 구조
| 방식 | 장점 | 단점 |
|---|---|---|
| **BYOK 직접 호출** | 서버 0, 운영비 0, "서비스 서버에는 문서가 남지 않음"을 정직하게 말할 수 있다 | 비개발자에게 API 키 발급은 큰 장벽이다. 키를 localStorage에 두면 XSS에 노출된다 |
| 서버 프록시 + 크레딧 | 키 발급 불필요, 결제 가능, 남용 방지 | 문서 텍스트가 내 서버를 지난다(무저장 정책과 고지가 필요). 운영비와 개인정보 처리 책임이 생긴다 |
| (나중) 로컬 모델(WebGPU) | 완전한 로컬 | 한국어 양식 이해 품질과 기기 사양 제약 [추정] |
- **직접 호출 가능 여부**
  - Claude: 2024-08부터 CORS를 지원한다. 헤더 `anthropic-dangerous-direct-browser-access: true`가 필요하고, TS SDK에서는 `dangerouslyAllowBrowser: true`로 켠다. 공식 README가 "브라우저는 키 노출 때문에 기본 비활성"이라고 명시하고, BYOK와 신뢰할 수 있는 내부 도구 용도로 권한다 (45, 46).
  - Gemini: `@google/genai` README에 브라우저 초기화 예제가 있다(경고 포함). Live API용 ephemeral token은 백엔드가 발급하는 방식이다 (47, 48). **AI Studio 무료 등급은 입력 데이터를 제품 개선에 쓸 수 있으므로** 문서 작업 기본값으로 쓰면 안 된다 (49).
  - OpenAI: SDK에 `dangerouslyAllowBrowser` 옵션이 있다 (45).
- **설계상 주의(Claude 최신 모델)**: Opus 5.5와 Sonnet 5.5에서는 forced `tool_choice`(`any`/`tool`)가 400 오류다. `auto` + `strict: true` 도구 정의 + 프롬프트 지시로 tool call을 유도하거나, structured outputs를 쓴다 (50).
- **비용 감각** (1회 = 입력 1만 토큰 [양식 블록 JSON + 시스템/도구 정의] + 출력 2천 토큰 가정, 환율 1달러 1,400원 [추정])
  | 모델 | 단가(입력/출력, $/MTok) | 1회 비용 | 원화 |
  |---|---|---|---|
  | Claude Haiku 5.5 | 0.10 / 0.50 (10만 토큰 이하) | 약 $0.002 | 약 3원 |
  | Claude Sonnet 5.5 | 2 / 10 | 약 $0.04 | 약 56원 |
  | Claude Opus 5.5 | 4 / 20 | 약 $0.08 | 약 112원 |
  | Gemini Flash 계열 | 출처마다 다름($0.30~1.50 / $2.50~9) [추정] | 약 $0.01~0.03 | 약 15~40원 |
  - 같은 양식으로 여러 번 대화하면 prompt caching이 효과적이다. 캐시 읽기는 입력의 약 0.1배(Opus 5.5는 0.05배), 5분 TTL 쓰기는 1.25배 (50). 시스템 프롬프트, 도구 정의, 문서 블록 JSON을 앞쪽 고정 prefix로 둔다.
  - 한국어는 영어보다 토큰을 더 쓴다 [추정]. 실측으로 다시 잡아야 한다.
  - 지니워크의 "공문 1건 44원" 주장과 같은 자릿수다 (26).

---

## 5. 결론

### 5-1. 차별점이 성립하는가
- **성립한다. 다만 좁게 잡아야 한다.**
  - 한컴독스 AI는 업로드형 클라우드이고 생성 중심이다. 한컴어시스턴트와 인라인AI는 한글 설치가 전제다. 헬피챗은 교사 플랫폼에 묶여 있다. ChatGPT와 Gemini는 HWPX를 돌려주지 않는다. 개발자 도구는 비개발자가 접근하기 어렵다.
  - 비어 있는 자리: **"받은 HWP/HWPX 양식 → 빈 칸·라벨 자동 인식 → AI가 칸별 초안 제안 → 사람이 카드 단위로 승인 → 원본 서식 그대로 HWPX"**를 **설치 없이, 파일 업로드 없이, 맥/윈도우 아무 브라우저에서** 하는 도구.
  - "일반 문서 작성 + AI"로 넓히면 한컴독스 AI와 정면으로 붙게 되어 승산이 낮다.
- 1차 타깃 제안: 정부지원사업·각종 신청서를 쓰는 **소상공인·창업자·프리랜서**, 그리고 개인 PC에서 가정통신문·계획서를 쓰는 **교사**. 공무원 업무망은 정책 장벽 때문에 후순위로 둔다.
- 솔직히 고지할 점: 파일은 업로드하지 않지만, **AI에 보내는 칸 텍스트는 LLM 제공자에게 전송된다.** "무엇을 보내는지 미리보기", 이름·주민번호 등 마스킹 옵션을 기본 제공해야 신뢰가 생긴다.

### 5-2. 기술 검증(주말 1~2번) 체크리스트
준비물: 실제 양식 10종(공문 2, 가정통신문 2, 정부지원사업 신청서 3, 표가 많은 서식 2, HWP 5.0 원본 1). 확인 도구는 맥용 한글이나 한글 Viewer, 한컴독스.

| # | 검증 항목 | GO 기준 |
|---|---|---|
| 1 | `@rhwp/core` 0.8.x 버전 고정 + Vite에서 WASM 로드, 첫 페이지 렌더링 시간 | brotli 전송 기준 첫 렌더링 3초 이내(일반 노트북), 20쪽 문서 스크롤 끊김 없음 |
| 2 | 10종 미리보기를 한글 Viewer 화면과 비교 | 쪽수 일치 9/10, 표 깨짐 없음 8/10 |
| 3 | 구조 추출: 문단, 표 셀(+라벨), 누름틀을 블록 JSON으로 변환 | 신청서 3종에서 사람이 채워야 할 칸의 90% 이상이 블록으로 잡힘 |
| 4 | 편집 적용: `insertTextInCellByPath`/`replaceText`/`setFieldValueByName` → `exportHwpxWithReport` | content-loss 보고 0건, **한글에서 10/10 열림**("문서 변조"나 복구 안내 없음), 채운 칸의 글자 겹침·자간 압축 없음 |
| 5 | 저장 XML 확인: 편집한 문단의 `linesegarray`가 생략되거나 정상인지, mimetype 순서·STORED 상태 | 편집 문단에 낡은 lineseg가 남아 있지 않음 |
| 6 | 대체 경로: 원본 ZIP 최소 패치(JSZip)로 같은 편집을 하고 4번과 비교 | 둘 중 하나라도 10/10이면 통과. 더 안전한 쪽을 기본값으로 |
| 7 | LLM 루프: 브라우저 BYOK(Claude Sonnet 5.5 또는 Haiku 5.5), `propose_edits` 도구 → 카드 UI [적용/취소] | 신청서 1건 채우기 제안 응답 30초 이내, 비용 100원 미만, 제안의 80% 이상을 그대로 적용 가능 |
| 8 | 원본이 HWP 5.0인 경우: 열기 → HWPX로 저장 | 한글에서 열림(실패하면 MVP에서 HWP 입력은 "읽기와 제안만" 지원) |
- **GO 판정**: 4번(한글에서 열림 10/10)과 3번(칸 인식 90%)이 동시에 통과하면 GO다. 4번이 7~9/10이면 실패 패턴을 분석하고 "지원 양식 화이트리스트"로 축소해 진행한다. 6/10 이하이면 rhwp 렌더링은 미리보기에만 쓰고, 저장은 원본 패치 전용으로 다시 설계한다.

### 5-3. 추천 스택과 MVP 범위
- **스택**
  - Vite + React + TS(정적 호스팅: Cloudflare Pages 등). rhwp 렌더링은 메인 스레드 Canvas에서 시작하고, 무거우면 Worker + OffscreenCanvas로 옮긴다 [추정: `measureTextWidth` 콜백을 OffscreenCanvas로 줄 수 있는지 PoC에서 확인]
  - `@rhwp/core` 버전 고정(정확한 버전 + 해시). 자체 어댑터 계층(`DocumentPort`)으로 감싸 API 변동과 포크 가능성에 대비
  - 저장: rhwp `exportHwpxWithReport` + JSZip 최소 패치기(대비책)
  - LLM: Anthropic TS SDK(`dangerouslyAllowBrowser`) BYOK, 모델 선택(Haiku 5.5 / Sonnet 5.5 / Opus 5.5). 키는 sessionStorage가 기본이고 "기억하기"를 선택할 때만 localStorage. 엄격한 CSP 적용
  - 폰트: OFL 대체 폰트를 필요할 때만 로드. 함초롬은 동봉하지 않음. 로컬 폰트 감지는 선택 사항
- **MVP 범위 (넣을 것)**
  1. 드래그로 열기(HWPX 우선, HWP 5.0은 열기와 미리보기)
  2. 미리보기(쪽 넘김, 확대) + 블록 하이라이트
  3. "채울 칸 찾기" → 오른쪽 패널에 칸 목록과 AI 제안 카드 [적용/취소/수정]
  4. 사용자가 정보 입력(자유 텍스트나 붙여 넣기) → AI가 칸에 매핑
  5. 적용 후 다시 렌더링 + 쪽수 변화 경고
  6. HWPX 다운로드(파일명 `원본_작성.hwpx`) + "한글에서 최종 확인하세요" 안내
  7. 전송 미리보기와 마스킹
- **MVP 범위 (뺄 것)**: 서식 변경, 행 추가와 표 구조 편집, 새 문서 생성(md→HWPX), HWP 저장, 협업, 로그인과 결제, 일반 편집기 기능.

### 5-4. 주요 리스크와 대응
| 리스크 | 대응 |
|---|---|
| ① **저장본이 한글에서 깨지거나 열리지 않음**(문서 변조, 쪽 퇴행, lineseg). rhwp는 v1.0 전이고 버전 간 퇴행 사례가 있음 | 버전 고정, 골든 양식 회귀 테스트(업그레이드 때마다), content-loss 0일 때만 rhwp 저장, 원본 최소 패치 대비책, 편집 범위를 "텍스트 교체"로 제한, "한글에서 최종 확인" 고지 |
| ② **미리보기와 실제 한글 화면의 차이**(대체 폰트, 약 7% 문서에서 쪽 안 드리프트) | "미리보기는 근사치" 표시, 쪽수 변화와 칸 넘침 경고, 로컬 한컴 폰트 감지 옵션 |
| ③ **경쟁과 플랫폼 리스크**(한컴독스 AI가 저렴함, ChatGPT가 HWPX 출력을 추가할 가능성, 헬피챗이 교사 시장 선점) | "받은 양식 칸 채우기 + 로컬 + 사람 승인"으로 특화. 신청서처럼 한컴이 우선순위를 두지 않을 틈새부터 공략. 기능 대신 양식별 품질(라벨 인식, 글자 예산)로 승부 |
| ④ **개인정보와 기관 정책**(LLM 전송, 공공 AI 가이드, 교사 개인정보 우려 2위) | BYOK 직접 호출(중계 서버 없음), 전송 미리보기, 마스킹, 기관 업무용이 아님을 명시, 무료 등급 학습 사용 경고. 장기적으로 로컬 모델 옵션 검토 |
| ⑤ **rhwp 의존과 버스 팩터**(핵심 2~3명, 0.x API 변동, 열린 이슈 363개) | 어댑터 계층, MIT 포크 가능성 확보, 쓰는 API를 최소 집합으로 고정. 업스트림에 재현 샘플 이슈를 올려 기여 |
| (추가) **BYOK 진입장벽**(비개발자가 키를 발급하기 어려움) | 초기에는 얼리어답터용 BYOK + 발급 가이드. 수요가 확인되면 무저장 프록시 + 소액 크레딧으로 전환 |

---

## 출처
1. rhwp GitHub README/메타데이터 — https://github.com/edwardkim/rhwp
2. @rhwp/editor npm README(0.8.7) — https://www.npmjs.com/package/@rhwp/editor
3. @rhwp/core npm 패키지(0.8.7, `rhwp.d.ts`, `rhwp_bg.wasm` 직접 다운로드·측정) — https://www.npmjs.com/package/@rhwp/core , tarball https://registry.npmjs.org/@rhwp/core/-/core-0.8.7.tgz
4. rhwp 웹 폰트 목록 — https://github.com/edwardkim/rhwp/blob/main/assets/fonts/FONTS.md , 메트릭 DB 가이드 https://github.com/edwardkim/rhwp/blob/main/ttfs/FONTS.md , THIRD_PARTY_LICENSES https://github.com/edwardkim/rhwp/blob/main/THIRD_PARTY_LICENSES.md
5. rhwp 문서 에이전트 exact command 계약 — https://github.com/edwardkim/rhwp/blob/devel/mydocs/tech/wasm_agent_surface/document_agent_command.md
6. rhwp CJK 폰트 폴백 전략 — https://github.com/edwardkim/rhwp/blob/main/mydocs/tech/font_fallback_strategy.md
7. rhwp #4599 HWPX 저장 사다리 드리프트 백로그 242건 — https://github.com/edwardkim/rhwp/issues/4599
8. rhwp 이슈 #7219 https://github.com/edwardkim/rhwp/issues/7219 , #7626 https://github.com/edwardkim/rhwp/issues/7626 , #7857 https://github.com/edwardkim/rhwp/issues/7857 , #6907 https://github.com/edwardkim/rhwp/issues/6907 , #7528 https://github.com/edwardkim/rhwp/issues/7528
9. rhwp HWPX section 직렬화 소스 — https://github.com/edwardkim/rhwp/blob/devel/src/serializer/hwpx/section.rs
10. treesoop/hwp-mcp — https://github.com/treesoop/hwp-mcp
11. 함초롬체 무료 배포 보도(검색 요약) — https://news.jkn.co.kr/post/339003
12. 한컴 번들 글꼴 사용 제한 보도 — https://v.daum.net/v/20220814184136303
13. rhwp ROADMAP — https://github.com/edwardkim/rhwp/blob/main/ROADMAP.md , 기여자 https://github.com/edwardkim/rhwp/graphs/contributors
14. rhwp 다운스트림: HOP https://github.com/golbin/hop , 알한글 https://github.com/postmelee/alhangeul-macos , claw-hwp https://github.com/DoHyun468/claw-hwp , rhwp-online-app https://github.com/Mugen-Houyou/rhwp-online-app , rhwptopdf https://github.com/sanguneo/rhwptopdf
15. kordoc — https://github.com/chrisryugj/kordoc , npm https://www.npmjs.com/package/kordoc (4.24.1 tarball 직접 분석: `HwpxSession`, `patchHwpxBlocks`, Node 내장 모듈 import)
16. HwpForge — https://github.com/ai-screams/HwpForge
17. 한컴독스 AI 정식 출시(CIO) — https://www.cio.com/article/3542389/
18. 한컴독스 요금(피클플러스, 2026-10-20) — https://pickle.plus/blog/hancom-office-prices-subscription
19. 한컴독스 AI 리뷰(바이라인, 검색 요약) — https://byline.network/2024/10/241014_004/
20. 한컴어시스턴트 구독형 출시 — https://byline.network/2025/09/9253/
21. 한컴어시스턴트 개인용 출시 — https://byline.network/2025/06/6241253/
22. 한컴어시스턴트 공급(비즈워치 2026-06) — https://news.bizwatch.co.kr/article/mobile/2026/06/29/0024
23. 엘리스스쿨 헬피챗 기능 확장(벤처스퀘어 2026-09-16) — https://www.venturesquare.net/1114121/
24. 인라인AI 가이드(위키독스 블로그, 403으로 본문 미확인·검색 요약) — https://wikidocs.net/blog/@myungsang/5561/
25. 세종 AI 확장 분석 — https://extensionauditor.com/scan/ai-ai-kakobalmhpnklegboefpkjkhilfaedjd , https://extscope.org/extension/kakobalmhpnklegboefpkjkhilfaedjd
26. 지니워크(크몽) — https://kmong.com/gig/795620
27. 노컷뉴스 "답답해서 만들었다" 쉽다 한글(2026-08-21) — https://nocutnews.co.kr/news/6565558
28. 전북교육청 서.비서 — https://www.jjan.kr/articleAmp/20250908580333
29. Scoopie(구 Peekaboo Labs) Claude HWP 지원 글(2026-04-30) — https://scoopie.ai/kr/blog/claude-hwp-file-support
30. 바이라인 "챗GPT, HWP 문서 읽는다"(2026-04-17) — https://byline.network/2026/04/17-563/
31. braindetox "AI 시대에 K-공문서 HWP를 못 여는 이유"(2026-06-21) — https://braindetox.kr/posts/ai_korean_hwp_document_problem_2026.html
32. (29)와 같음
33. 클리앙 "클로드를 이용한 한글 파일 생성 편집"(2026-05-11) — https://www.clien.net/service/board/park/19188960
34. (31)과 같음(91.1% 인용)
35. 위키독스 인사발령 자동화 — https://wikidocs.net/261665 , 크몽 서식 상품 https://kmong.com/gig/724595
36. 클리앙 맥 게시판 — https://www.clien.net/service/board/cm_mac/17593541 , https://www.clien.net/service/board/park/16782200
37. 한국교육신문 KICE 교사 AI 활용 조사(2026-10-08) — https://hangyo.com/mobile/article.html?no=109594
38. 직장인 AI 활용 조사(검색 요약) — https://www.koreabizreview.com/articles/kbr-news-issue-briefing-ai-ai-20261002-p24s
39. 행안부 정부 전용 AI 시범서비스 — https://newsseoul.co.kr/news/view/1065590421968872 , https://newsseoul.co.kr/news/view/1065595206980331
40. 공공부문 AI 윤리원칙(경향) https://www.khan.co.kr/article/202511031510001/ , 공공부문 AI 도입·활용 가이드(KDI) https://eiec.kdi.re.kr/policy/materialView.do?num=282444 , KISA 안내서 https://www.kisa.or.kr/2060301/form?postSeq=41 , 2023 입장(아시아경제) https://view.asiae.co.kr/article/2023101709253213926
41. MTN 정부 hwp 첨부 제한(2026-04-24) — https://news.mtn.co.kr/news-detail/2026042407250110165
42. SuperDoc AGENTS.md — https://cdn.jsdelivr.net/npm/superdoc@1.45.0/AGENTS.md
43. Word Agent Mode 지원 문서 — https://support.microsoft.com/office/agent-mode-in-word-647d5d14-eaec-4e8a-a574-7cefffa7f8f0 , MC1384426 https://mc.merill.net/message/MC1384426
44. Tiptap AI Suggestion / Review changes — https://tiptap.dev/docs/content-ai/capabilities/agent/review/ai-suggestion , https://tiptap.dev/docs/ai/ai-toolkit/client/agents/review-changes
45. Simon Willison, Claude API CORS 지원 — https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access
46. Anthropic TS SDK README(`dangerouslyAllowBrowser`) — https://github.com/anthropics/anthropic-sdk-typescript
47. Google js-genai README(Browser 절) — https://github.com/googleapis/js-genai
48. Gemini ephemeral tokens — https://ai.google.dev/gemini-api/docs/ephemeral-tokens
49. Gemini 가격·무료 등급(2차 출처, 수치 불일치) — https://www.morphllm.com/gemini-api-pricing , https://hashnode.com/blog/gemini-api-pricing-2026
50. Claude API 모델·가격·캐싱(claude-api 스킬 캐시 2026-10-06; 공식 가격 페이지 https://www.anthropic.com/pricing)

---

## 핵심 결론 5줄
1. rhwp는 npm `@rhwp/core`(WASM 11.8MB, brotli 3.1MB)로 브라우저 안에서 열기·렌더링·텍스트/표 셀/누름틀 편집·`exportHwpx`(손실 보고 포함)까지 이미 된다. lineseg 함정도 "모르면 생략" 원칙으로 처리하고 있어 기술 핵심은 성립한다.
2. 다만 v1.0 전이라 HWPX 저장본이 한글에서 "문서 변조"로 열리지 않거나 버전 간 쪽 배치가 퇴행하는 이슈가 열려 있다. 버전 고정, 골든 양식 회귀, 원본 ZIP 최소 패치 대비책을 처음부터 넣어야 한다.
3. 경쟁자(한컴독스 AI, 한컴어시스턴트, 인라인AI, 헬피챗)는 업로드나 한글 설치를 전제로 하고, ChatGPT·Gemini는 읽기만 한다. "받은 양식의 칸을 AI가 제안하고 사람이 승인해 원본 그대로 HWPX로 받기, 설치·업로드 없이"라는 자리는 비어 있다.
4. 공무원 업무망은 AI 정책 장벽이 크므로 1차 타깃은 정부지원사업 신청서를 쓰는 소상공인·창업자와 개인 PC로 작업하는 교사로 잡는다. LLM은 BYOK 브라우저 직접 호출(Claude CORS 지원, 1회 약 3~110원)로 시작한다.
5. 주말 PoC GO 기준: 실제 양식 10종에서 채울 칸 90% 이상 인식 + 채운 HWPX가 한글에서 10/10 깨짐 없이 열림. 설계는 rhwp agent command(SHA 결속)와 kordoc `patchBlocks`/`capability()`의 블록 ID 제안 → 검증 → 승인 패턴을 따른다.
