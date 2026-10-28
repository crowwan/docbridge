// PDF 로 내보낼 쪽 모으기(SPEC-008, ADR 005) — 뷰어·테스트 뷰어 공용.
// 쪽마다 rhwp 쪽 SVG(모양)와 쪽 글자 배치(글자·빈칸·자리, 보이지 않는 글자 층) — 서버가 pdf-export.ts 로 PDF 를 만든다.
// 문서를 바꾸지 않는다(편집이 아니다). 하이라이트·note·바뀐 블록 표시는 뷰어 DOM 오버레이라 여기 없다.
import type { HwpDocument } from '@rhwp/core';

export interface PdfPage {
  svg: string;
  textLayout: string;
}

/** pages: 0부터 센 쪽. 문서에 없는 쪽이면 던진다(서버가 먼저 거르지만 그사이 쪽 수가 바뀔 수 있다) */
export function pdfPages(doc: HwpDocument, pages: number[]): PdfPage[] {
  const count = doc.pageCount();
  return pages.map((page) => {
    if (page >= count) throw new Error(`문서에 ${page + 1}쪽이 없습니다(${count}쪽). 다시 내보내세요.`);
    return { svg: doc.renderPageSvg(page), textLayout: doc.getPageTextLayout(page) };
  });
}
