// 만든 PDF 들여다보기(#107 기술 검증): 쪽 크기(mm)·뽑은 글자(pdfjs-dist)·넣은 글꼴(pdf-lib 로 FontDescriptor 읽기).
// 테스트(tests/pdf-spike.test.ts)와 확인 파일 스크립트(scripts/make-pdf-check.ts)가 같이 쓴다.
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const PT_TO_MM = 25.4 / 72;

export interface InspectedPage {
  widthMm: number;
  heightMm: number;
  /** pdfjs 가 뽑은 글자 묶음을 그대로 이은 것(빈칸·줄바꿈은 pdfjs 판단) */
  text: string;
}

export interface InspectedPdf {
  pages: InspectedPage[];
  /** 넣은 글꼴 이름(FontDescriptor FontName, 부분 집합이면 ABCDEF+ 앞붙이) */
  embeddedFonts: string[];
  /** 글꼴 파일이 없는(넣지 않은) 글꼴 이름 */
  unembeddedFonts: string[];
  /** Type3 글꼴(윤곽을 글리프로 넣은 것 — CFF 글꼴) 이름 */
  type3Fonts: string[];
}

export async function inspectPdf(bytes: Uint8Array): Promise<InspectedPdf> {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const pages: InspectedPage[] = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = page.view;
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      text += item.str;
      if (item.hasEOL) text += '\n';
    }
    pages.push({ widthMm: (x1 - x0) * PT_TO_MM, heightMm: (y1 - y0) * PT_TO_MM, text });
  }
  await task.destroy();

  const pdf = await PDFDocument.load(bytes);
  const embeddedFonts: string[] = [];
  const unembeddedFonts: string[] = [];
  const type3Fonts: string[] = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    if (object.get(PDFName.of('Subtype')) === PDFName.of('Type3')) {
      const name = object.get(PDFName.of('Name'));
      type3Fonts.push(name instanceof PDFName ? name.decodeText() : '?');
    }
    if (object.get(PDFName.of('Type')) !== PDFName.of('FontDescriptor')) continue;
    const name = object.get(PDFName.of('FontName'));
    const label = name instanceof PDFName ? name.decodeText() : '?';
    const file = object.get(PDFName.of('FontFile2')) ?? object.get(PDFName.of('FontFile3')) ?? object.get(PDFName.of('FontFile'));
    (file === undefined ? unembeddedFonts : embeddedFonts).push(label);
  }
  return { pages, embeddedFonts, unembeddedFonts, type3Fonts };
}

/** 쪽마다 내용 스트림(그리기 명령) 글 — 테스트가 글자 간격·빈칸 글자를 본다 */
export async function pageContents(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => pdf.context.lookup(ref)) : [contents];
    return streams
      .map((stream) => (stream instanceof PDFRawStream ? new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode()) : ''))
      .join('\n');
  });
}

/** 빈칸·줄바꿈을 모두 뺀 글자(본문과 뽑은 글자 비교용 — PDF 는 빈칸을 글자로 갖지 않고 자리로만 둔다) */
export function compact(text: string): string {
  return text.replace(/\s+/g, '');
}
