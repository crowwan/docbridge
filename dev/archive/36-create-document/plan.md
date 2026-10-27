# #36 새 문서 만들기: create_document 와 새 문서 저장

SPEC-003 AC-1·2·7·8·9. 선행 #35(ADR 003, `src/core/create-document.ts`).

## 결정

- **새 문서 바이트는 뷰어가 만든다.** 서버 → 뷰어 `create_document`(파일 이름, 양식 base64·keepContent). 뷰어가 rhwp 로 빈 문서/양식 비우기 + 제목 스타일 → 그리기 → 블록(첫 문단 keepEmpty)·스타일·지운/남긴 개체를 돌려준다. 서버는 rhwp 를 띄우지 않는다(문서 상태의 기준은 뷰어, SPEC-001 구성). 서버에서 만들어 HWPX 로 보내면 HWPX 왕복이 한 번 더 들고 서버에 WASM 이 필요하다.
- 세션 문서의 자리: `location = { kind: 'file', path, sourcePath } | { kind: 'new', savePath }`. 새 문서를 처음 저장하면 `file`(저장한 파일이 마지막 파일·원본).
- 경로 규칙: create 때 절대·`~` 만, 확장자 규칙·폴더·이미 있음 거부(save-path 의 공통 검사 재사용). 경로 없는 저장 = savePath 배타 생성, 상대 경로는 savePath 폴더 기준.
- 새로고침: 새 문서(저장 전)는 다시 띄울 파일이 없다 → 열린 문서를 비우고 "저장하지 않은 새 문서가 사라졌습니다" 알림. 뷰어는 저장 전 새 문서면 편집이 없어도 확인 창(`edit_state.newDocument`).

## 순서

1. 스펙(바이트 경로·저장 규칙·결과 모양) → 2. core(createNewDocument, DocumentEditor keepEmpty) → 3. 프로토콜·뷰어·테스트 뷰어 → 4. 경로 규칙 → 5. 세션 create·저장·새로고침 → 6. MCP 도구 → 7. 테스트(AC 별) → 8. E2E·스크린샷 → 9. README·CLAUDE.md → PR

## 병렬 이슈

#37(styles, `src/core/styles.ts` 로 옮길 수 있음)·#38(insert_table) 뒤에 머지. 마지막 rebase 때 `paragraphStyles` import 를 맞춘다.
