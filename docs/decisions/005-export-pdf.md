---
id: 005
status: accepted       # proposed | accepted | superseded — 2026-10-28 사용자가 ~/Downloads/docbridge-pdf-check 의 PDF(a)를 macOS 미리보기로 확인("괜찮다")
date: 2026-10-28
---

# 005. PDF 로 내보내기: 쪽 SVG + 글자 배치 → 서버에서 pdf-lib 로 그리기(글자 모양 = 시스템 글꼴 윤곽, 글자 = 보이지 않는 글자 층)

## 상황

SPEC-008(PDF 로 내보내기)의 `export_pdf`·"PDF" 버튼(#108·#109)에 들어가기 전에, rhwp 쪽 SVG(`renderPageSvg`)로 **글자가 선택·검색되는** PDF 를 만들 수 있는지, 한글 글꼴은 어디서 얻는지, 크기·시간이 얼마인지 확인해야 했다(#107, 스펙 열린 질문 둘).

- 후보: (a) pdf-lib(+@pdf-lib/fontkit)로 SVG 를 직접 그리기, (b) jsPDF + svg2pdf.js, (c) 대조용으로 쪽을 그림으로 찍기
- 문서: fixture 5개(notice.hwpx·notice.hwp·application·outline-demo·report) + 레포 밖 실제 공고문 `2026년 희망두배 청년통장 신규 참여자 모집 공고문.hwpx`(8쪽, 읽기만)
- 측정은 뷰어처럼 **Chromium 안에서**(Playwright, `scripts/make-pdf-check.ts` + `scripts/pdf-check/browser.ts`) — 뷰어처럼 Canvas 로 글자 폭을 재서 rhwp 가 화면과 같은 줄 배치로 SVG 를 내게 했다. 같은 SVG 를 Node(서버 자리)에서도 그려 쟀다
- 글자 확인은 두 가지: pdfjs-dist 로 뽑은 글자, **macOS PDFKit(미리보기 엔진)** 으로 뽑은 글자와 `findString`(미리보기 ⌘F 와 같은 검색). 모양은 Quick Look(PDFKit) 렌더를 화면 Canvas 와 나란히 놓고 봤다

rhwp 쪽 SVG 의 모양(0.8.7):

- 글자는 **글자마다 `<text>` 하나**(자리 x 를 글자마다 준다), 빈칸 글자는 그리지 않는다. `transform="translate() scale(장평,1)"`, `textLength`(글자 폭 맞춤), 굵게 흉내 획(`stroke` = 글자색, 글자 크기의 2%), 글머리 "·" 는 원으로 그리고 글자는 `fill-opacity="0"`
- `font-family` 는 문서 글꼴 + rhwp 대체 차례(예: `'휴먼명조','Batang','바탕','Nanum Myeongjo','AppleMyungjo','Noto Serif KR',…,serif`)
- 도형: `rect`·`line`·`circle`·`clipPath`(표 칸 자르기). rhwp 바이너리에는 `path`(호 포함)·`polygon`·`ellipse`·`image`·`linearGradient`·`radialGradient`·`pattern`·`filter`·`marker` 도 있다
- `getPageTextLayout(쪽)` 의 글자는 SVG 글자와 같다(fixture 5개·공고문 8쪽 모두 빈칸 뺀 글자 집합이 같음) — 여기에는 **빈칸까지 문서 글자 그대로**와 글자마다 자리(`charX`)가 있다

## 결정

**GO (accepted — 2026-10-28 사용자가 확인 파일을 미리보기로 봄).** 뷰어는 쪽마다 `renderPageSvg` + `getPageTextLayout` 을 서버로 보내고, **서버(Node)** 가 `src/core/pdf-export.ts` `svgPagesToPdf` 로 PDF 를 만든다(pdf-lib 1.17.1 + @pdf-lib/fontkit 1.1.1, 둘 다 MIT). 사용자가 확인 파일을 미리보기로 보고 이상이 없으면 accepted.

1. **SVG 는 직접 그린다(DOM 없이).** `src/core/pdf-svg.ts` 가 rhwp SVG 를 요소 나무로 읽고, `pdf-export.ts` 가 쪽 전체에 0.75배·y 뒤집기 행렬을 한 번 걸어 SVG 좌표 그대로 그린다. 그리는 것: `g`(transform·`clip-path`·투명도), `rect`·`line`·`circle`·`ellipse`·`polygon`·`polyline`·`path`(pdf-lib `svgPathToOperators` — 호 포함), 선 굵기·점선·끝·이음, `image`(PNG·JPEG data URI). **비슷하게만 그리는 것은 `warnings`** 로 모은다: 그러데이션 → 첫 색 단색, `pattern` 채우기·`filter`(그림자)·`marker`(화살표) → 그리지 않음, PNG·JPEG 가 아닌 그림 → 그리지 않음. 측정한 6개 문서에는 해당 요소가 없었다(warnings 0).
2. **보이는 글자 = 화면과 같은 글꼴의 윤곽.** 글자마다 그 글꼴의 글리프 윤곽(fontkit 이 읽은 경로)을 Form XObject 로 한 번 넣고(`src/core/pdf-glyphs.ts`, 글꼴·글자·테두리 두께마다 하나), SVG 자리·크기·장평·`textLength`·색으로 그린다. 굵은 글꼴이 없으면 테두리를 덧그리고(합성 굵게, 1/30em), 기울임 글꼴이 없으면 기울인다. rhwp 의 굵게 흉내 획(글자색·2%)은 화면 Canvas 처럼 **굵은 글꼴**을 고른다(`strokeBold`).
3. **선택·검색·복사 = 보이지 않는 글자 층.** `getPageTextLayout` 의 글자(빈칸 포함)를 글자마다 그 자리 폭에 꼭 맞게(가로 배율 `Tz`) 투명하게 얹는다(`src/core/pdf-text-layer.ts`, 스캔 PDF 의 OCR 글자 층과 같은 방식). 글꼴은 글자마다 1em 네모를 그리는 Type3 글꼴 + ToUnicode(한 바이트 코드라 255자마다 하나), 층 전체를 투명도 0 으로 그린다. 글자 배치가 없으면 SVG 글자를 그 자리에 둔다(빈칸 없음).
4. **글꼴은 서버가 시스템 글꼴 폴더에서 읽는다(뷰어 번들에 넣지 않는다).** `src/core/pdf-fonts-node.ts` 가 맥(`/System/Library/Fonts`·`Supplemental`·`/Library/Fonts`·`~/Library/Fonts`·**내려받는 시스템 글꼴 `/System/Library/AssetsV2/com_apple_MobileAsset_Font*`**)·윈도우(`%WINDIR%\Fonts`·`%LOCALAPPDATA%\Microsoft\Windows\Fonts`)·리눅스 폴더를 훑어 **파일 머리만** 읽고(이름 — 모든 언어·굵기·기울임·fsType), `src/core/pdf-fonts.ts` `FontResolver` 가 SVG `font-family` 차례에서 **브라우저처럼** 고른다: 차례대로 "있고 그 글자가 있는" 첫 글꼴(cmap 확인), 굵기는 CSS 규칙, 없으면 serif·sans-serif 기본 글꼴 → 다른 쪽 기본 글꼴 → 기호 글꼴(Apple Symbols 등). 모음(.ttc)은 그 글꼴만 떼어 낸다. OS/2 fsType 이 "넣지 마시오"(Restricted)인 글꼴은 고르지 않는다. 맥의 `.` 으로 시작하는 숨은 시스템 글꼴은 뺀다.
   - **글꼴 라이선스 근거**(PR #112 리뷰): 이 방식은 글꼴 파일(부분 집합 포함)을 PDF 에 넣지 않고, 쓴 글리프의 **윤곽만** 그림으로 그린다 — 인쇄 출력·종이를 스캔한 것에 가깝고 PDF 에서 글꼴을 꺼내 다시 쓸 수 없다. 그래도 fsType 을 따르는 것은 보수적으로 지키려는 것이다: macOS 사용권 계약은 시스템 글꼴로 내용을 표시·인쇄하는 것은 허용하고 "내용에 넣는 것은 그 글꼴의 넣기 제한이 허용할 때만" 이라고 하므로, 넣기 제한(fsType)을 기준으로 삼으면 윤곽 그림이 "넣기"로 해석되더라도 어긋나지 않는다. 쓰는 글꼴 — 맥 시스템 글꼴(AppleMyungjo·Apple SD Gothic Neo·Apple Symbols, fsType 0 설치 가능), 나눔(SIL OFL — 문서에 넣기 허용), 윈도우 맑은 고딕·바탕(fsType 8 편집 가능) — 은 모두 넣기를 허용한다. Restricted(맥 1,213개 중 4개)만 건너뛴다.
5. **PDF 는 서버에서 만든다.** 브라우저에서 만들면 시스템 글꼴 바이트를 통째로 뷰어로 보내야 한다(공고문 74.3MB, 시간의 2/3). 서버에서는 같은 일이 디스크 읽기이고 다시 쓸 때 캐시한다. 뷰어 번들은 그대로이고, THIRD_PARTY_NOTICES 도 지금처럼 서버 번들만 보면 된다(뷰어 의존성은 NOTICES 가 안 모은다 — PR #97 리뷰).

## 검증 결과

Apple M3 Pro, macOS 26.6, Node 24.14, Playwright 1.64.1 Chromium, 시스템 글꼴 1,213개(머리 읽기 160~260ms). 세 번 잰 가운데 값. 브라우저 시간은 PDF 만들기(글꼴 받기 포함, SVG 만들기 제외), Node 는 같은 SVG·글자 배치로 서버 자리에서 처음(글꼴 읽기 포함) / 다시(읽어 둔 글꼴).

### 고른 방식 (a) — 글자 윤곽 + 글자 층

| 문서 | 쪽 | 쪽 크기 | PDF | 브라우저 ms(쪽당) | 그중 글꼴 받기 | Node 처음 / 다시 ms | 뽑은 글자 pdfjs / PDFKit | 쓴 글꼴 |
|---|---|---|---|---|---|---|---|---|
| notice.hwpx | 1 | 210.0×297.0mm | 104KB | 180 | 113ms(8.6MB) | 138 / 68 | 21/21 · 21/21 | 나눔명조 Regular·ExtraBold |
| notice.hwp | 1 | 〃 | 104KB | 162 | 109ms | 117 / 69 | 21/21 · 21/21 | 〃 |
| application.hwpx | 1 | 〃 | 55KB | 143 | 110ms | 75 / 43 | 10/10 · 10/10 | 〃 |
| outline-demo.hwpx | 3 | 〃 | 93KB | 104 (35) | 52ms | 91 / 66 | 46/46 · 46/46 | 나눔명조 Regular |
| report.hwpx | 2 | 〃 | 182KB | 220 (110) | 117ms | 194 / 133 | 54/54 · 54/54 | 나눔명조 Regular·ExtraBold |
| 실제 공고문(.hwpx) | 8 | 〃 | 634KB | 1,526 (191) | 1,037ms(74.3MB) | 690 / 492 | 283/283 · 283/283 | Apple SD Gothic Neo Regular·Medium·Bold, 나눔명조 Regular·ExtraBold, AppleMyungjo, Apple Symbols |

- "뽑은 글자" = 본문 글자 묶음(문단 번호+글자, 표 칸 글자)이 빈칸을 뺀 PDF 글자에 들어 있는 수. 빠진 글리프 0(공고문의 `∙ ‧ ․ ⇨` 는 Apple Symbols 에서)
- 쪽 SVG + 글자 배치 만들기: 공고문 8쪽 49ms, 문서 열기 14ms. SVG 는 쪽당 40~350KB(공고문 8쪽 2.8MB)
- 미리보기 검색(PDFKit `findString`, 공고문): "18:00" 3곳, "서울특별시장" 1, "신규 참여자" 2, "희망두배 청년통장" 6, "제2026-1456호" 1, "고용․산재보험" 3, "https://total.comwel.or.kr" 1 — 모두 찾음
- 모양(Quick Look 렌더 ↔ 화면 Canvas): 표 선·칸 색·글머리 원·쪽 나눔·글꼴(명조/고딕)이 같다. 굵게 제목은 화면보다 아주 조금 가늘다(같은 Bold 글꼴, 화면 Canvas 의 굵게 처리 차이)

### 시도했다가 바꾼 것 — 글자를 PDF 글꼴 글자로 넣기

처음에는 보이는 글자를 pdf-lib 부분 집합 글꼴(CID 글꼴)의 PDF 글자로 넣었다(PDF 더 작음: 공문 37KB, 공고문 318KB). 두 가지가 막혔다.

| 문제 | 근거 |
|---|---|
| **CFF 글꼴(맥 Apple SD Gothic Neo — 고딕 차례의 맥 글꼴)을 pdf-lib 가 부분 집합으로 넣으면 미리보기가 못 읽는다.** "Replacing Type1 font … with Helvetica" 로 한글이 기호로 깨진다. 다른 CFF 글꼴(Noto Sans Javanese)도 같고, OTF 로 감싸도 같다. 통째로 넣으면 되지만 글꼴 하나에 수 MB | `CG_PDF_VERBOSE`, Quick Look 렌더(스크래치) |
| **미리보기가 글자 사이에 빈칸을 넣는다.** rhwp 글자 자리(한글 글꼴 지표·자간·양쪽 정렬)와 PDF 글꼴 폭이 0.1em 이상 다르면 빈칸으로 읽어 "18: 00", "『 희망", "- 1456" 이 되고, 미리보기 검색 "18:00"·"서울특별시장"·"고용․산재보험" 이 0곳이었다. 글자 간격(Tc)·ActualText 로 메워도 PDFKit 은 무시했다 | PDFKit 틈 실험: 0.08em 까지 붙임, 0.1em 부터 빈칸(스크래치) |

글자 층으로 바꾼 뒤 CFF 문제는 사라지고(윤곽은 글꼴 형식과 상관없음), 빈칸은 문서 그대로 나온다(위 검색 모두 찾음. 공고문 본문 묶음을 빈칸까지 그대로 비교하면 280/283 — 나머지 3개는 줄이 바뀌는 자리에 미리보기가 줄바꿈을 넣은 것. 줄을 넘는 낱말 검색은 다른 PDF 도 같다). 대신 PDF 가 2~3배 커지고(글리프 윤곽), PDF 글꼴 목록에는 글자 층 글꼴(`DocbridgeTextLayer`, Type3)만 보인다.

### 후보 비교 (같은 SVG, 브라우저)

| 후보 | 공문 1쪽 | 보고서 2쪽 | 공고문 8쪽 | 글자 |
|---|---|---|---|---|
| (a) pdf-lib 직접 + 글자 층(고름) | 104KB · 180ms | 182KB · 220ms | 634KB · 1,526ms | 모두 뽑힘, 미리보기 검색 됨 |
| (b) jsPDF 4.2.1 + svg2pdf.js 2.8.1 | 226KB · 406ms | 260KB · 498ms | 330KB · 2,431ms | fixture 는 뽑히지만 **공고문 15/283**: jsPDF 는 TrueType 만 읽어 CFF(Apple SD Gothic Neo) 글꼴이 이름뿐인 Type1 로 들어가 고딕 글자가 깨진다. 미리보기가 "unexpected symbol `Infinity'" 오류. 글자 사이 빈칸 문제는 (a) 처음 방식과 같다. DOM 이 있어야 해서 서버에서 못 돈다 |
| (c) 그림(Canvas ×2 → JPEG 0.9) | 152KB · 34ms | 749KB · 140ms | 2,849KB · 483ms | **0** — 글자 선택·검색 불가(기준 미달, 대조용) |

### 한글 글꼴을 어디서 얻나

| 방법 | 화면과 같은 글꼴 | .mcpb 증가 | 비고 |
|---|---|---|---|
| **서버가 시스템 글꼴 읽기(고름)** | 예(브라우저와 같은 차례·같은 파일) | 0 | 맥 내려받는 글꼴(나눔명조 등)은 AssetsV2 에 있다 — 처음엔 빠뜨려 화면(나눔명조)과 PDF(AppleMyungjo)가 달랐다 |
| 뷰어에 오픈 글꼴 묶기(Noto Sans/Serif KR, KS X 1001 2,350자 + 기호 서브셋, Regular·Bold) | 아니오(맥 화면은 Apple SD Gothic Neo·나눔명조) | 글꼴 4개 TTF 5.2MB, zip 약 2.2MB(woff2 로도 1.45MB) | 완성형 밖 한글(예 "똠")은 빠진다. 11,172자 전부면 몇 배 |
| 브라우저 Local Font Access API(`queryLocalFonts`) | 예 | 0 | Chromium 만, 권한 창이 뜬다. 사용자 기본 브라우저가 Safari 면 안 됨 |

- 쓴 글꼴의 fsType: Apple Symbols·AppleMyungjo·나눔명조·나눔고딕 0(설치 가능), 히라기노 8(편집 가능). 맥 시스템 글꼴 1,213개 중 넣지 말라는 것 4개(고르지 않음)
- 시스템에 차례의 글꼴이 하나도 없고 기본·기호 글꼴에도 그 글자가 없으면 그 글자는 보이지 않고(`stats.missingGlyphs`) 글자 층에는 남는다

### 의존성·.mcpb 크기

- 이 PR: pdf-lib 1.17.1·@pdf-lib/fontkit 1.1.1·jspdf 4.2.1·svg2pdf.js 2.8.1·pdfjs-dist 6.4.299 를 **devDependencies** 로(측정·테스트용). 제품 번들(서버·뷰어)이 새 모듈을 가져오지 않아 `.mcpb` 크기 변화 0 — 4,937,915 바이트(main d1d1391 위, `npm run test:pack` 통과). 묶인 서버·뷰어에 PDF 코드 0곳, THIRD_PARTY_NOTICES 10개 패키지 그대로
- #108 에서 서버가 `pdf-export.ts`·`pdf-fonts-node.ts` 를 가져오면(했다 — "결과"): pdf-lib·@pdf-lib/fontkit 를 dependencies 로 옮긴다. 서버 번들 +2.7MB(@pdf-lib/fontkit 1.5MB·pdf-lib 0.8MB·pako 0.2MB·standard-fonts·upng·tslib, 압축 0.68MB) → .mcpb 약 **+0.7MB**. 라이선스: pdf-lib·@pdf-lib/fontkit·@pdf-lib/standard-fonts·@pdf-lib/upng MIT, pako MIT AND Zlib, tslib 0BSD — NOTICES 에 자동으로 들어간다
- 비교: (b) jsPDF+svg2pdf 는 압축 0.28MB 지만 뷰어 번들에 들어가야 하고(NOTICES 가 뷰어를 안 봄) 글꼴을 뷰어로 보내야 한다
- `pdf-lib/cjs/api/svgPath.js` 는 패키지 안쪽 경로다(공개 API 에 없음). 버전을 고정했으니 올릴 때 테스트로 확인한다

## 검토한 대안

| 대안 | 장점 | 단점 |
|---|---|---|
| (a) pdf-lib 직접 + 글자 윤곽 + 글자 층 (고름) | DOM 없이 서버에서 돈다, 글꼴 형식 상관없음, 미리보기 검색이 문서 빈칸 그대로, 화면과 같은 글꼴 | SVG 요소를 직접 그려야 함(그러데이션·무늬·필터·화살표는 비슷하게만), PDF 가 글꼴 글자보다 2~3배, PDF 글꼴 목록에 실제 글꼴 이름이 없다, 글리프 힌팅 없음 |
| (a') pdf-lib + PDF 글꼴 글자(처음 방식) | PDF 가장 작음, 진짜 글꼴 | 맥 CFF 글꼴이 미리보기에서 깨짐, 미리보기 검색이 글자 사이 빈칸으로 깨짐 |
| (b) jsPDF + svg2pdf.js | SVG 요소를 거의 다 그림(그러데이션·무늬·화살표) | TrueType 만 → 맥 고딕 깨짐, 브라우저(DOM) 전용 → 글꼴을 뷰어로 보내야 함, 느리고 큼, 같은 빈칸 문제 |
| (c) 쪽 그림 | 가장 빠르고 모양 그대로 | 글자 선택·검색 불가 — 스펙 품질 기준 미달 |
| 서버 헤드리스 브라우저 `page.pdf` | 품질 좋음 | .mcpb 에 브라우저를 넣을 수 없다(스펙 기술 메모) |
| 뷰어 `window.print()` | 브라우저 인쇄 품질 | 사람이 대화 상자에서 골라야 해 도구로 못 씀 |

## NO-GO 일 때

사용자가 미리보기에서 모양·검색이 안 맞는다고 하면:
1. 모양만 문제면 (a) 의 그리는 부분을 고친다(요소별). (글꼴 이름 맞추기는 GO 여도 할 일이라 #108 에서 했다 — "결과")
2. 검색이 문제면 글자 층 기준선·높이(`LAYER_BASELINE`)를 고친다
3. 그래도 안 되면 (c) 그림 + 글자 층(지금 글자 층을 그대로)으로 간다 — 모양은 화면 그대로, 크기는 커진다(공고문 2.8MB). 이 경우 스펙 "그림으로 찍지 않는다" 를 "보이는 모양은 그림, 글자는 층" 으로 바꾼다

## 결과

- #108(`export_pdf`, `src/server/export-pdf-tool.ts`): 뷰어 요청 `export_pdf_pages`(0부터 센 쪽 → 쪽마다 SVG + 글자 배치 + 화면 글꼴 이름)를 **20쪽 묶음**으로 받는다(공고문 쪽당 SVG 350KB — 묶음 하나 많아야 7MB, ws 상한 100MB). 쪽은 문서 줄(session.exclusive) 안에서 받고(모두 같은 편집 시점), PDF 만들기·쓰기는 줄 밖에서 한다. 하이라이트·note·초록 표시는 뷰어 오버레이라 SVG 에 없다 — E2E 가 실제 뷰어에서 표시가 있을 때와 없을 때 SVG 가 같고 PDF 에 note 글자가 없는지 본다(AC-3)
- **서버 글꼴 읽기는 비동기**(PR #112 리뷰): 목록 훑기(폴더 읽기·파일 머리 읽기, 동시 16개)와 글꼴 바이트 읽기 모두 `fs.promises`. 목록은 처음 내보낼 때 한 번 훑어 서버 수명 동안 쓴다. 글꼴 바이트는 **96MB 상한 LRU 캐시**(`FONT_CACHE_BYTES`): 공고문이 쓴 글꼴 7개(70.9MB, 모음은 떼어 낸 글꼴만)가 들어가 다시 내보낼 때 다시 읽지 않고, 다른 문서로 넘어가도 서버가 100MB 남짓 넘게 붙잡지 않는다. 글자 있는지(cmap)는 cmap 표만 떠 둔다. PDF 를 만드는 동안 쪽·글꼴·글자 묶음 100개마다 다음 이벤트 루프 차례로 넘기고 `pdf.save({ objectsPerTick: 50 })` 로 쓴다
- **화면 글꼴 이름 맞추기**(PR #112 리뷰 — NO-GO 조건에서 옮김): 뷰어가 SVG `font-family` 차례마다 이 브라우저에 있는 첫 글꼴을 Canvas 글자 폭(`"이름", monospace|serif|sans-serif` 와 일반 글꼴만의 폭이 다른지)으로 재서 보내고(`src/core/screen-fonts.ts`), 서버는 그 이름을 차례 맨 앞에 두고 고른다. 서버 글꼴에 그 이름이 없거나 넣지 말라는 글꼴이면 다른 글꼴로 그리고 warnings(`화면 글꼴 "…" 를 이 컴퓨터 글꼴에서 쓸 수 없음`) — AssetsV2 를 빠뜨렸던 것 같은 차이를 사용자에게 알린다. 실제 Chromium 에서 공문 fixture 차례 → `Nanum Myeongjo`(E2E)
- 그 글자가 든 글꼴이 하나도 없으면(글꼴 없는 리눅스 CI 등) warnings `글꼴이 없어 그리지 못한 글자(선택·검색은 됨) n곳`. 설치판 테스트(test:pack)는 글꼴에 기대지 않는 단언(쪽 수·글자 층 글자)만 해서 CI 리눅스에서도 돈다 — 시험 글꼴을 서버에 넣는 설정은 두지 않았다
- 측정(#108, `node scripts/measure-pdf-export.ts [문서…] [--pages N]`, M3 Pro·Node 24.14, 세 번): 시스템 글꼴 훑기 106~114ms(이벤트 루프 최대 멈춤 2ms). **처음 내보내기**(글꼴 읽기 포함) 공문 1쪽 130ms·공고문 8쪽 778~798ms, **다음** 67ms·499~516ms. 그동안 이벤트 루프 최대 멈춤 약 0.1초(큰 글꼴 하나를 fontkit 이 여는 시간 — 나눌 수 없음). 큰 문서: 쪽을 되풀이한 300쪽 공문 2.4초(쪽당 7.9ms)·공고문 6.0초(쪽당 20ms, PDF 5.9MB), 최대 멈춤 0.08~0.21초. 뷰어 SVG(쪽당 6ms)와 전송을 더해도 300쪽 10초 안팎이라 MCP 요청 제한 시간은 바꾸지 않고, 진행 알림(MCP progress, progressToken 이 있을 때)을 묶음마다·PDF 만들기 전에 보낸다
- 한계: 큰 문서는 메모리를 많이 쓴다 — 측정 스크립트 프로세스 RSS 공고문 300쪽 1.6GB(rhwp 문서·쪽 SVG 문자열·SVG 요소 나무를 한꺼번에 들고 있다). 수백 쪽 공문이 흔해지면 쪽마다 읽고 그린 뒤 버리게 바꾼다
- 의존성: pdf-lib 1.17.1·@pdf-lib/fontkit 1.1.1 을 dependencies 로. `.mcpb` 4,937,915 → 5,641,367 바이트(+703,452, +0.67MB), 서버 번들 4.4MB. THIRD_PARTY_NOTICES 에 @pdf-lib/fontkit·standard-fonts·upng, pdf-lib, pako, tslib 이 자동으로 더해졌다 — @pdf-lib/fontkit 은 패키지에 LICENSE 파일이 없어(package.json MIT) `scripts/pack/licenses/@pdf-lib__fontkit.txt` 보충 고지를 쓴다
- 확인하지 못한 것: 윈도우·리눅스 시스템 글꼴(맑은 고딕·바탕은 TrueType 이라 문제 없을 것으로 봄, 폴더 목록만 테스트), 그러데이션·무늬·그림자·화살표가 든 실제 문서, PNG·JPEG 가 아닌 그림(rhwp 가 BMP·WMF 를 data URI 로 줄 때 — 뷰어가 Canvas 로 PNG 로 바꿔 보내는 방법), 세로쓰기, 수식, 머리말·꼬리말·각주가 든 문서(글자 배치에 들어오는지), Acrobat·Chrome PDF 뷰어에서의 검색
- 다시 볼 조건: rhwp 를 올릴 때(SVG 요소·글자 배치 모양), pdf-lib 을 올릴 때(CFF 부분 집합이 고쳐지면 (a') 로 크기를 줄일 수 있다), **macOS 판을 올릴 때**(`/System/Library/AssetsV2/com_apple_MobileAsset_Font*` 는 Apple 이 공개하지 않은 경로 — 바뀌면 나눔명조 등이 빠진다. 화면 글꼴 warnings 로 드러난다)

확인 파일: `node scripts/make-pdf-check.ts [폴더] --doc <실제 문서>`(기본 `~/Downloads/docbridge-pdf-check`, 레포에 넣지 않음). 문서마다 a(고른 방식)·b(jsPDF)·c(그림) PDF 와 화면 첫 쪽 PNG, `README.txt`(확인할 것), `measurements.json`. 테스트는 `tests/pdf-spike.test.ts`(묶음 `SPEC-008 … (기술 검증)`, 레포에 넣은 시험 글꼴 `tests/fonts/` = Noto Sans KR 부분 집합, OFL).

## 변경 이력

| 날짜 | 내용 |
|---|---|
| 2026-10-28 | proposed(#107 기술 검증) |
| 2026-10-28 | accepted — 사용자가 `~/Downloads/docbridge-pdf-check/` 의 PDF(고른 방식 a)를 macOS 미리보기로 확인. #108: 글꼴 라이선스 근거, 서버 글꼴 비동기 읽기·96MB 캐시, 화면 글꼴 이름 맞추기(NO-GO 조건에서 "결과"로), 측정·.mcpb 크기, macOS 판 다시 볼 조건 |
