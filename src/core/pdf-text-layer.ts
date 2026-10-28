// 보이지 않는 글자 층 — PDF 내보내기 기술 검증(#107, ADR 005).
// 보이는 글자는 윤곽 그림(pdf-glyphs.ts)이라, 선택·검색·복사는 이 층이 맡는다(스캔 PDF 의 OCR 글자 층과 같은 방식).
// 글자는 rhwp 쪽 글자 배치(getPageTextLayout — 빈칸까지 문서 글자 그대로)에서 오고, 글자마다 그 글자 자리 폭에 꼭 맞게
// 가로 배율(Tz)을 걸어 둔다. 그래서 PDF 뷰어가 글자 사이 틈을 빈칸으로 잘못 읽지 않고, 진짜 빈칸만 빈칸 글자로 나온다.
// 글꼴은 Type3 글꼴(글자마다 폭 1em 네모, ToUnicode 로 글자 값) — 한 바이트 코드라 255자마다 하나씩.
// 미리보기(PDFKit)는 아무것도 그리지 않는 글리프의 글자는 읽지 않고, Type3 에는 보이지 않는 글자 방식(Tr 3)이 듣지 않는다.
// 그래서 글리프는 글자 칸만 한 네모를 그리고, 글자 층 전체를 투명도 0 으로 그린다(pdf-export.ts paintTextLayer).
import { PDFHexString, PDFName, type PDFDocument, type PDFRef } from 'pdf-lib';

const CODES_PER_FONT = 255;
/** 글자 층 글꼴 이름(PDF 글꼴 목록에 보이는 이름) */
export const TEXT_LAYER_FONT = 'DocbridgeTextLayer';

interface LayerChunk {
  ref: PDFRef;
  chars: string[];
}

export interface LayerGlyph {
  ref: PDFRef;
  hex: PDFHexString;
}

function utf16Hex(text: string): string {
  let hex = '';
  for (let i = 0; i < text.length; i += 1) hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return hex;
}

function byteHex(code: number): string {
  return code.toString(16).padStart(2, '0').toUpperCase();
}

function toUnicodeCmap(chars: string[]): string {
  const lines = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<00> <FF>',
    'endcodespacerange',
  ];
  for (let i = 0; i < chars.length; i += 100) {
    const block = chars.slice(i, i + 100);
    lines.push(`${block.length} beginbfchar`);
    block.forEach((char, j) => lines.push(`<${byteHex(i + j + 1)}> <${utf16Hex(char)}>`));
    lines.push('endbfchar');
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  return lines.join('\n');
}

export class TextLayerFont {
  private readonly pdf: PDFDocument;
  private readonly chunks: LayerChunk[] = [];
  private readonly codes = new Map<string, { chunk: LayerChunk; code: number }>();

  constructor(pdf: PDFDocument) {
    this.pdf = pdf;
  }

  /** 글자 하나(유니코드 글자) → 글꼴(덩어리)과 코드 */
  glyph(char: string): LayerGlyph {
    let found = this.codes.get(char);
    if (found === undefined) {
      let chunk = this.chunks[this.chunks.length - 1];
      if (chunk === undefined || chunk.chars.length >= CODES_PER_FONT) {
        chunk = { ref: this.pdf.context.nextRef(), chars: [] };
        this.chunks.push(chunk);
      }
      chunk.chars.push(char);
      found = { chunk, code: chunk.chars.length };
      this.codes.set(char, found);
    }
    return { ref: found.chunk.ref, hex: PDFHexString.of(byteHex(found.code)) };
  }

  /** 쓴 글자로 글꼴 사전들을 쓴다(저장 전에 한 번) */
  finish(): void {
    const { context } = this.pdf;
    // 모든 글자가 같은 그림: 폭 1000(1em), 글자 칸(아래 0.2em ~ 위 0.8em) 네모. d1 = 색은 바깥(투명) 것을 쓴다
    const box = context.register(context.flateStream('1000 0 0 -200 1000 800 d1\n0 -200 1000 1000 re f'));
    for (const chunk of this.chunks) {
      const procs: Record<string, PDFRef> = {};
      const differences: Array<number | PDFName> = [1];
      chunk.chars.forEach((_, i) => {
        procs[`c${i + 1}`] = box;
        differences.push(PDFName.of(`c${i + 1}`));
      });
      context.assign(
        chunk.ref,
        context.obj({
          Type: 'Font',
          Subtype: 'Type3',
          Name: TEXT_LAYER_FONT,
          FontBBox: [0, -200, 1000, 800],
          FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
          CharProcs: procs,
          Encoding: { Type: 'Encoding', Differences: differences },
          FirstChar: 1,
          LastChar: chunk.chars.length,
          Widths: chunk.chars.map(() => 1000),
          Resources: {},
          ToUnicode: context.register(context.flateStream(toUnicodeCmap(chunk.chars))),
        }),
      );
    }
  }

  get fontCount(): number {
    return this.chunks.length;
  }
}
