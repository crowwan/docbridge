// 보이는 글자 = 글꼴 윤곽 그림 — PDF 내보내기 기술 검증(#107, ADR 005).
// 쪽에 보이는 글자는 PDF 글자가 아니라 글꼴 윤곽(fontkit 이 읽은 경로)을 Form XObject 로 넣어 그린다.
// - 글자로 넣으면 PDF 글꼴 폭과 rhwp 가 준 글자 자리가 조금만 달라도(0.1em) 미리보기가 글자 사이에 빈칸을 넣어 검색이 깨진다.
//   글자는 보이지 않는 글자 층(pdf-text-layer.ts)이 자리에 꼭 맞게 따로 맡는다
// - pdf-lib 1.17.1 의 CFF 글꼴 부분 집합(맥 Apple SD Gothic Neo 등)은 미리보기가 못 읽는다 — 윤곽이면 글꼴 형식과 상관없다
// 글리프 하나(글꼴·글리프·테두리 두께)마다 Form 하나를 만들어 문서 전체에서 다시 쓴다.
import fontkit, { type Font } from '@pdf-lib/fontkit';
import type { PDFDocument, PDFRef } from 'pdf-lib';
import { svgPathToOperators } from 'pdf-lib/cjs/api/svgPath.js';

export interface GlyphForm {
  ref: PDFRef;
  /** 글자 폭(em) */
  advance: number;
}

/** 쓴 글꼴(바이트에서 연 fontkit 글꼴)과 글리프 Form 모음 */
export class GlyphForms {
  private readonly pdf: PDFDocument;
  private readonly fonts = new Map<string, Font>();
  private readonly forms = new Map<string, GlyphForm>();

  constructor(pdf: PDFDocument) {
    this.pdf = pdf;
  }

  addFont(id: string, bytes: Uint8Array): void {
    if (!this.fonts.has(id)) this.fonts.set(id, fontkit.create(bytes));
  }

  private font(id: string): Font {
    const font = this.fonts.get(id);
    if (font === undefined) throw new Error(`넣지 않은 글꼴입니다: ${id}`);
    return font;
  }

  /** 글자 폭(em) — Form 을 만들지 않고 잰다 */
  advance(fontId: string, char: string): number {
    const font = this.font(fontId);
    const upm = font.unitsPerEm > 0 ? font.unitsPerEm : 1000;
    return font.glyphForCodePoint(char.codePointAt(0) ?? 0).advanceWidth / upm;
  }

  /**
   * 글자의 윤곽 Form. 좌표는 em(글꼴 단위를 /Matrix 로 1em = 1 로), y 위쪽.
   * strokeEm > 0 이면 채우고 테두리도 그린다(굵게 합성·SVG 글자 테두리 — 테두리 색은 그릴 때의 획 색)
   */
  form(fontId: string, char: string, strokeEm: number): GlyphForm {
    const stroke = Math.round(strokeEm * 1000) / 1000;
    const key = `${fontId}|${char}|${stroke}`;
    const cached = this.forms.get(key);
    if (cached !== undefined) return cached;
    const font = this.font(fontId);
    const upm = font.unitsPerEm > 0 ? font.unitsPerEm : 1000;
    const glyph = font.glyphForCodePoint(char.codePointAt(0) ?? 0);
    const path = svgPathToOperators(glyph.path.toSVG())
      .map((operator) => operator.toString())
      .join('\n');
    const width = stroke * upm;
    const paint = path.length === 0 ? '' : width > 0 ? `${width.toFixed(1)} w 1 j\n${path}\nB` : `${path}\nf`;
    const box = glyph.bbox;
    const pad = width / 2 + 1;
    const bbox = [box.minX - pad, box.minY - pad, box.maxX + pad, box.maxY + pad].map((value) => (Number.isFinite(value) ? Math.round(value) : 0));
    const { context } = this.pdf;
    const ref = context.register(
      context.flateStream(paint, { Type: 'XObject', Subtype: 'Form', BBox: bbox, Matrix: [1 / upm, 0, 0, 1 / upm, 0, 0], Resources: {} }),
    );
    const form = { ref, advance: glyph.advanceWidth / upm };
    this.forms.set(key, form);
    return form;
  }

  get count(): number {
    return this.forms.size;
  }
}
