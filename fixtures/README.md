# fixtures

테스트용 한글 문서. 모두 개인정보가 없다.

| 파일 | 형태 | 담긴 것 | 출처 |
|---|---|---|---|
| `notice.hwpx` | 공문(2쪽 이하) | 본문 문단, 자동 문단 번호(`1.`·`가.`), 3×3 표, 누름틀 1개 | docbridge 생성 |
| `notice.hwp` | 위와 같은 공문의 HWP 5.0 바이너리 | 같음 | docbridge 생성 |
| `report.hwpx` | 보고서(여러 쪽) | 개요 번호(`1.`·`가.`) 문단, 4×4 표, 긴 본문 | docbridge 생성 |
| `application.hwpx` | 신청서 양식 | 라벨 칸이 있는 4×2 표, 누름틀 2개, 오른쪽·가운데 정렬 | docbridge 생성 |
| `outline-demo.hwpx` | 개요 3단계 문서(3쪽) | 개요 번호 3단계, 1×1 표(표 안 개요 번호 포함) | rhwp 레포 |

## docbridge 생성 문서

- `scripts/make-fixtures.ts` 가 `@rhwp/core` 0.8.7 편집 API(`createBlankDocument`, `insertText`, `splitParagraph`, `applyParaFormat`, `createTable`, `insertClickHereField` 등)로 만든다. 다시 만들기: `node scripts/make-fixtures.ts`
- 내용(기관명 "가나다구청" 등)은 모두 지어낸 것이다.
- 라이선스: 이 레포와 같다(docbridge 가 만든 저작물).
- 한컴오피스가 아니라 rhwp 직렬화기로 저장한 파일이라, 한컴이 저장한 실제 문서보다 서식이 단순하다. 실제 문서 렌더링은 ADR 001 의 로컬 측정(레포에 넣지 않음)으로 따로 확인했다.

## rhwp 레포에서 가져온 문서

| 파일 | 원래 경로 | 커밋 | 라이선스 |
|---|---|---|---|
| `outline-demo.hwpx` | `mydocs/pr/assets/issue7445/outline_navigation_panel_demo.hwpx` | [`def947c`](https://github.com/edwardkim/rhwp/blob/def947c2149df5bc812d801e6e79be19a403b4d1/mydocs/pr/assets/issue7445/outline_navigation_panel_demo.hwpx) (devel, 2026-10-23). 처음 들어온 커밋 `ece45b7` | MIT (edwardkim/rhwp) |

- 개요 탐색 기능 시연용으로 rhwp 기여자가 생성기로 만든 문서다(커밋 `ece45b7` 메시지: "데모 원문·생성기출력은 보존자산으로"). 실제 기관 문서가 아니다.
- SHA-256: `90e7442874bee1e5f774287b38323ed556e241539c783e100d0b7b93631aa6b4`
- rhwp 의 다른 실제 공문 샘플(서울시 정보공개 문서, 실제 기관 공문 등)은 원 저작권·라이선스가 따로 적혀 있지 않아 넣지 않았다.
