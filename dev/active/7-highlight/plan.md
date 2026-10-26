# #7 근거 하이라이트 highlight · clear_highlight — 계획

범위: SPEC-001 AC-7 + PR #10 리뷰 이월(빈 문단이 낀 범위의 보정 포기) + 글자 위치 단위 정리(#6 와 조율).

## 설계

```
MCP highlight(targets: TextTarget[], note?) / clear_highlight()
  └ server/highlight-tools.ts ── session.requestWithDocument('highlight', document → params)
       │  id 표로 id → 위치(anchor). 없는 id 는 보내기 전에 오류
       ▼
     뷰어(viewer/main.ts) highlightTargets
       │  indexOfAnchor(blocks, anchor) → 자기 블록
       │  core/highlight-targets.ts targetRects: 문단·칸(칸 문단 나누기)·표 전체·누름틀(값/안내문) → 사각형
       │     └ core/highlight-rects.ts selectionRects (줄 왼쪽·오른쪽 끝 보정, 빈 문단 건너뜀)
       │  모두 성공한 뒤에만 이전 것 지우고 그림 → note → 첫 사각형 scrollIntoView(center)
       ▼
     { pages } → 서버가 { highlighted, pages(중복 제거·오름차순) }
```

## 결정

- D-1 글자 위치 단위 = 유니코드 글자(code point). rhwp 와 같은 단위(실험: "𠀀😀가나" 길이 4). find_text·read_blocks·get_outline 도 이 단위로(core/chars.ts).
- D-2 표 cell 없음 = 표 전체를 쪽마다 칸 bbox 합집합 사각형 하나.
- D-3 빈 누름틀 = 캐럿 자리에서 시작하는 안내문 글자 배치(run)를 칠함. 못 찾으면 캐럿 자리 글자 하나 크기.
- D-4 표 안 표 누름틀(path 2단 이상)은 오류. v0.1 범위 밖.
- D-5 색·note: 노랑 반투명 multiply(기존 값 유지), note 는 진한 꼬리표(gray-900 면·흰 14px), 첫 사각형 위·왼쪽 맞춤. 시안 비교 생략(design.md 에 이유).
- D-6 스크롤은 즉시(부드러운 스크롤 없음) — 결정적 테스트.
