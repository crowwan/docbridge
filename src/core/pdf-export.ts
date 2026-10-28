// 쪽 SVG(rhwp renderPageSvg) → PDF — PDF 내보내기 기술 검증(#107, ADR 005).
// pdf-lib 로 SVG 를 직접 그린다(DOM 없이: Node 서버·테스트·브라우저 공용).
// - 보이는 글자: 화면과 같은 글꼴(FontResolver 가 SVG font-family 차례에서 브라우저처럼 고른 시스템 글꼴)의 윤곽 그림(pdf-glyphs.ts)
// - 선택·검색·복사: 보이지 않는 글자 층(pdf-text-layer.ts) — rhwp 쪽 글자 배치(getPageTextLayout)의 글자를 그 자리에 꼭 맞게
// rhwp SVG 좌표는 CSS 픽셀(96dpi): 쪽 전체에 0.75 배·y 뒤집기 행렬을 한 번 걸고 SVG 좌표 그대로 그린다.
import {
  LineCapStyle,
  LineJoinStyle,
  PDFDocument,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  TextRenderingMode,
  appendBezierCurve,
  beginText,
  clip,
  closePath,
  concatTransformationMatrix,
  drawObject,
  endPath,
  endText,
  fill,
  fillAndStroke,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setDashPattern,
  setFillingRgbColor,
  setFontAndSize,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  stroke,
  type PDFImage,
  type PDFName,
  type PDFPage,
  type PDFRef,
} from 'pdf-lib';
import { svgPathToOperators } from 'pdf-lib/cjs/api/svgPath.js';
import { z } from 'zod';
import { parseJson } from './json.ts';
import { FontResolver, type FontChoice, type FontLibrary } from './pdf-fonts.ts';
import { GlyphForms } from './pdf-glyphs.ts';
import { TEXT_LAYER_FONT, TextLayerFont } from './pdf-text-layer.ts';
import {
  isElement,
  multiply,
  numberAttr,
  parseColor,
  parseFontFamilies,
  parseFontWeight,
  parseSvg,
  parseTransform,
  textContent,
  type Rgb,
  type SvgElement,
} from './pdf-svg.ts';

/** CSS 픽셀 → PDF 포인트(1px = 1/96in, 1pt = 1/72in) */
export const PX_TO_PT = 0.75;

/** 기울임 글꼴이 없을 때 기울이는 비율(브라우저 합성 기울임과 비슷하게 약 12°) */
const SYNTHETIC_ITALIC_SKEW = 0.21;
/** 굵은 글꼴이 없을 때 덧그리는 글자 테두리 두께(em). 브라우저 합성 굵게와 비슷하게 */
const SYNTHETIC_BOLD_STROKE = 1 / 30;
/** rhwp SVG 가 굵게를 흉내 내는 글자 획 두께(글자 크기 비율) */
const RHWP_BOLD_STROKE = 0.02;
/** 원·타원을 베지에 넷으로 그릴 때의 상수 4(√2−1)/3 */
const KAPPA = 0.5522847498;
/** 글자 층 글자의 기준선: 줄 위쪽 + 줄 높이 × 이 값(rhwp SVG 기준선과 비교해 잼 — 공문 fixture 0.85) */
const LAYER_BASELINE = 0.85;

export interface PdfExportStats {
  pages: number;
  textElements: number;
  /** 글꼴을 찾지 못해 빠진(보이지 않는) 글자 수 */
  missingGlyphs: number;
  /** 윤곽을 넣은 글꼴 열쇠(FontEntry.id) */
  fonts: string[];
  /** 넣은 글리프 윤곽 수 */
  glyphForms: number;
}

export interface PdfExportResult {
  bytes: Uint8Array;
  stats: PdfExportStats;
  /** 그리지 못하거나 비슷하게만 그린 것(그러데이션·무늬·그림자·화살표 …) — 종류별 한 줄 */
  warnings: string[];
}

interface TextRun {
  element: SvgElement;
  families: string[];
  weight: number;
  italic: boolean;
  text: string;
}

/** 쪽 하나: rhwp renderPageSvg 결과와(있으면) 같은 쪽 getPageTextLayout JSON */
export interface PdfPageSource {
  svg: string;
  /**
   * 쪽 글자 배치(rhwp getPageTextLayout) — 글자 층의 글자와 자리. SVG 에는 빈칸 글자가 없어서 빈칸까지 여기서 읽는다.
   * 없으면 SVG 글자(빈칸 없음)를 그 자리에 글자 층으로 둔다
   */
  textLayout?: string;
}

const textLayoutSchema = z.object({
  runs: z.array(
    z.object({
      text: z.string(),
      x: z.number(),
      y: z.number(),
      h: z.number(),
      charX: z.array(z.number()),
      fontSize: z.number().optional(),
    }),
  ),
});

/** 글자 층 글자 하나(쪽 px): 자리 왼쪽 x·폭, 기준선 y, 글자 크기 */
interface LayerChar {
  char: string;
  x: number;
  width: number;
  baseline: number;
  size: number;
}

function layoutChars(textLayout: string): LayerChar[] {
  return parseJson(textLayoutSchema, textLayout).runs.flatMap((run) => {
    const size = run.fontSize ?? run.h;
    return [...run.text].map((char, i) => {
      const start = run.charX[i] ?? 0;
      const end = run.charX[i + 1] ?? start + size * 0.5;
      return { char, x: run.x + start, width: Math.max(end - start, 0.01), baseline: run.y + run.h * LAYER_BASELINE, size };
    });
  });
}

/** 쪽들 → PDF 바이트. 쪽 크기는 SVG width·height(px) 그대로 */
export async function svgPagesToPdf(sources: PdfPageSource[], library: FontLibrary): Promise<PdfExportResult> {
  const pdf = await PDFDocument.create();
  const resolver = new FontResolver(library);
  const pages = sources.map((source) => parseSvg(source.svg));
  const warnings = new Map<string, number>();
  const warn = (kind: string): void => {
    warnings.set(kind, (warnings.get(kind) ?? 0) + 1);
  };

  // 1) 글자마다 글꼴을 고른다(글꼴 바이트를 읽어 글자가 있는지 봐야 해서 먼저 다 한다)
  const runs: TextRun[] = [];
  for (const svg of pages) collectText(svg, runs);
  const glyphFonts = new Map<SvgElement, Array<FontChoice | undefined>>();
  let missingGlyphs = 0;
  for (const run of runs) {
    const choices: Array<FontChoice | undefined> = [];
    for (const char of run.text) {
      const choice = await resolver.resolve(run.families, run.weight, run.italic, char);
      if (choice === undefined && char.trim().length > 0) missingGlyphs += 1;
      choices.push(choice);
    }
    glyphFonts.set(run.element, choices);
  }

  // 2) 쓰인 글꼴을 연다(윤곽은 쓸 때 글리프마다 Form 으로)
  const glyphs = new GlyphForms(pdf);
  const usedIds = new Set<string>();
  for (const choices of glyphFonts.values()) {
    for (const choice of choices) {
      if (choice === undefined || usedIds.has(choice.id)) continue;
      usedIds.add(choice.id);
      glyphs.addFont(choice.id, await library.load(choice.id));
    }
  }

  // 3) 쪽마다 그리고, 글자 층을 얹는다
  const textLayer = new TextLayerFont(pdf);
  const images = new Map<string, PDFImage>();
  for (const [index, svg] of pages.entries()) {
    const width = numberAttr(svg, 'width');
    const height = numberAttr(svg, 'height');
    const page = pdf.addPage([width * PX_TO_PT, height * PX_TO_PT]);
    const textLayout = sources[index]?.textLayout;
    const painter = new PagePainter({ pdf, page, svg, glyphs, textLayer, glyphFonts, images, warn });
    await painter.paint(textLayout === undefined ? undefined : layoutChars(textLayout));
  }
  textLayer.finish();

  const bytes = await pdf.save();
  return {
    bytes,
    stats: { pages: pages.length, textElements: runs.length, missingGlyphs, fonts: [...usedIds], glyphForms: glyphs.count },
    warnings: [...warnings].map(([kind, count]) => `${kind} ${count}곳`),
  };
}

/**
 * rhwp SVG 는 글자 모양 "굵게" 를 글자색과 같은 색 획(글자 크기의 2%)으로 그린다. 뷰어 Canvas 는 같은 글자를 굵은 글꼴로 그려서
 * (화면: Apple SD Gothic Neo Bold 등) PDF 도 굵은 글꼴을 고르고 획은 그리지 않는다 — 굵은 글꼴이 없으면 합성 굵게
 */
function strokeBold(element: SvgElement): boolean {
  const stroke = element.attrs.get('stroke');
  if (stroke === undefined || stroke !== (element.attrs.get('fill') ?? '#000000')) return false;
  const size = numberAttr(element, 'font-size', 16);
  const ratio = numberAttr(element, 'stroke-width', 0) / size;
  return Math.abs(ratio - RHWP_BOLD_STROKE) < 0.002;
}

function collectText(element: SvgElement, runs: TextRun[]): void {
  if (element.tag === 'defs' || element.tag === 'clipPath') return;
  if (element.tag === 'text') {
    runs.push({
      element,
      families: parseFontFamilies(element.attrs.get('font-family')),
      weight: strokeBold(element) ? Math.max(parseFontWeight(element.attrs.get('font-weight')), 700) : parseFontWeight(element.attrs.get('font-weight')),
      italic: element.attrs.get('font-style') === 'italic' || element.attrs.get('font-style') === 'oblique',
      text: textContent(element),
    });
    return;
  }
  for (const child of element.children) if (isElement(child)) collectText(child, runs);
}

/** 원·타원 → 베지에 경로 연산자 */
function ellipseOperators(cx: number, cy: number, rx: number, ry: number): PDFOperator[] {
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  return [
    moveTo(cx + rx, cy),
    appendBezierCurve(cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry),
    appendBezierCurve(cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy),
    appendBezierCurve(cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry),
    appendBezierCurve(cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy),
    closePath(),
  ];
}

function pointsOperators(points: string | undefined, close: boolean): PDFOperator[] {
  const values = (points ?? '').split(/[\s,]+/).filter((part) => part.length > 0).map(Number);
  const operators: PDFOperator[] = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    const x = values[i] ?? 0;
    const y = values[i + 1] ?? 0;
    operators.push(i === 0 ? moveTo(x, y) : lineTo(x, y));
  }
  if (close && operators.length > 0) operators.push(closePath());
  return operators;
}

interface PagePainterInput {
  pdf: PDFDocument;
  page: PDFPage;
  svg: SvgElement;
  glyphs: GlyphForms;
  textLayer: TextLayerFont;
  glyphFonts: Map<SvgElement, Array<FontChoice | undefined>>;
  images: Map<string, PDFImage>;
  warn: (kind: string) => void;
}

class PagePainter {
  private readonly ids = new Map<string, SvgElement>();
  /** 쪽 자원 이름(글리프·글자 층 글꼴·그림·투명도) — 부를 때마다 새 이름이 생기므로 쪽마다 한 번만 */
  private readonly xobjectNames = new Map<string, PDFName>();
  private readonly fontNames = new Map<string, PDFName>();
  private readonly imageNames = new Map<PDFImage, PDFName>();
  private readonly opacityNames = new Map<string, PDFName>();
  /** 글자 배치가 없을 때 글자 층에 둘 SVG 글자들 */
  private readonly svgChars: LayerChar[] = [];
  private readonly input: PagePainterInput;

  constructor(input: PagePainterInput) {
    this.input = input;
    this.indexIds(input.svg);
  }

  private indexIds(element: SvgElement): void {
    const id = element.attrs.get('id');
    if (id !== undefined) this.ids.set(id, element);
    for (const child of element.children) if (isElement(child)) this.indexIds(child);
  }

  private referenced(value: string | undefined): SvgElement | undefined {
    const id = /^url\(#([^)]+)\)$/.exec(value?.trim() ?? '')?.[1];
    return id === undefined ? undefined : this.ids.get(id);
  }

  /** layer: 글자 층 글자(글자 배치에서). 없으면 SVG 글자로 */
  async paint(layer: LayerChar[] | undefined): Promise<void> {
    const { svg, page } = this.input;
    const height = numberAttr(svg, 'height');
    const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(PX_TO_PT, 0, 0, -PX_TO_PT, 0, height * PX_TO_PT)];
    const viewBox = (svg.attrs.get('viewBox') ?? '').split(/[\s,]+/).map(Number);
    const [vx = 0, vy = 0, vw = 0, vh = 0] = viewBox;
    const width = numberAttr(svg, 'width');
    if (vw > 0 && vh > 0 && (vw !== width || vh !== height || vx !== 0 || vy !== 0)) {
      ops.push(concatTransformationMatrix(width / vw, 0, 0, height / vh, -vx * (width / vw), -vy * (height / vh)));
    }
    for (const child of svg.children) if (isElement(child)) await this.paintElement(child, ops);
    this.paintTextLayer(layer ?? this.svgChars, ops);
    ops.push(popGraphicsState());
    page.pushOperators(...ops);
  }

  private xobjectName(ref: PDFRef): PDFName {
    const key = ref.toString();
    let name = this.xobjectNames.get(key);
    if (name === undefined) {
      name = this.input.page.node.newXObject('G', ref);
      this.xobjectNames.set(key, name);
    }
    return name;
  }

  private fontName(ref: PDFRef): PDFName {
    const key = ref.toString();
    let name = this.fontNames.get(key);
    if (name === undefined) {
      name = this.input.page.node.newFontDictionary(TEXT_LAYER_FONT, ref);
      this.fontNames.set(key, name);
    }
    return name;
  }

  private opacityState(fillOpacity: number, strokeOpacity: number): PDFOperator | undefined {
    if (fillOpacity >= 1 && strokeOpacity >= 1) return undefined;
    const key = `${fillOpacity}/${strokeOpacity}`;
    let name = this.opacityNames.get(key);
    if (name === undefined) {
      name = this.input.page.node.newExtGState('GS', this.input.pdf.context.obj({ Type: 'ExtGState', ca: fillOpacity, CA: strokeOpacity }));
      this.opacityNames.set(key, name);
    }
    return setGraphicsState(name);
  }

  /** fill 색. 기본은 검정(SVG 규칙), url(#…) 그러데이션은 첫 색으로 비슷하게, 무늬는 그리지 않는다 */
  private fillColor(element: SvgElement): Rgb | undefined {
    const value = element.attrs.get('fill');
    if (value === undefined) return { r: 0, g: 0, b: 0 };
    const referenced = this.referenced(value);
    if (referenced !== undefined) {
      if (referenced.tag === 'linearGradient' || referenced.tag === 'radialGradient') {
        this.input.warn('그러데이션(첫 색 단색으로)');
        const firstStop = referenced.children.find((child): child is SvgElement => isElement(child) && child.tag === 'stop');
        return firstStop === undefined ? undefined : parseColor(firstStop.attrs.get('stop-color'));
      }
      this.input.warn(`${referenced.tag} 채우기(그리지 않음)`);
      return undefined;
    }
    return parseColor(value);
  }

  private strokeStyle(element: SvgElement): PDFOperator[] | undefined {
    const color = parseColor(element.attrs.get('stroke'));
    if (color === undefined) return undefined;
    const ops: PDFOperator[] = [setStrokingRgbColor(color.r, color.g, color.b), setLineWidth(numberAttr(element, 'stroke-width', 1))];
    const dash = element.attrs.get('stroke-dasharray');
    if (dash !== undefined && dash !== 'none') {
      const values = dash.split(/[\s,]+/).filter((part) => part.length > 0).map(Number).filter(Number.isFinite);
      if (values.length > 0) ops.push(setDashPattern(values, 0));
    }
    const cap = element.attrs.get('stroke-linecap');
    if (cap === 'round') ops.push(setLineCap(LineCapStyle.Round));
    if (cap === 'square') ops.push(setLineCap(LineCapStyle.Projecting));
    const join = element.attrs.get('stroke-linejoin');
    if (join === 'round') ops.push(setLineJoin(LineJoinStyle.Round));
    if (join === 'bevel') ops.push(setLineJoin(LineJoinStyle.Bevel));
    return ops;
  }

  /** 도형 경로를 칠한다(fill·stroke·투명도) */
  private paintShape(element: SvgElement, path: PDFOperator[], ops: PDFOperator[], fillable = true): void {
    if (path.length === 0) return;
    const fillRgb = fillable ? this.fillColor(element) : undefined;
    const strokeOps = this.strokeStyle(element);
    if (fillRgb === undefined && strokeOps === undefined) return;
    ops.push(pushGraphicsState());
    const opacity = numberAttr(element, 'opacity', 1);
    const state = this.opacityState(opacity * numberAttr(element, 'fill-opacity', 1), opacity * numberAttr(element, 'stroke-opacity', 1));
    if (state !== undefined) ops.push(state);
    const transform = element.attrs.get('transform');
    if (transform !== undefined) ops.push(concatTransformationMatrix(...parseTransform(transform)));
    if (fillRgb !== undefined) ops.push(setFillingRgbColor(fillRgb.r, fillRgb.g, fillRgb.b));
    if (strokeOps !== undefined) ops.push(...strokeOps);
    ops.push(...path);
    ops.push(fillRgb !== undefined && strokeOps !== undefined ? fillAndStroke() : fillRgb !== undefined ? fill() : stroke());
    ops.push(popGraphicsState());
    if (element.attrs.has('marker-start') || element.attrs.has('marker-end')) this.input.warn('선 끝 모양(화살표 등, 그리지 않음)');
  }

  /** 자르기 경로(clipPath 안 rect·path·원) → W n */
  private clipOperators(clipPathElement: SvgElement): PDFOperator[] {
    const ops: PDFOperator[] = [];
    for (const child of clipPathElement.children) {
      if (!isElement(child)) continue;
      ops.push(...this.shapePath(child));
    }
    if (ops.length === 0) return [];
    return [...ops, clip(), endPath()];
  }

  private shapePath(element: SvgElement): PDFOperator[] {
    switch (element.tag) {
      case 'rect': {
        const width = numberAttr(element, 'width');
        const height = numberAttr(element, 'height');
        if (width <= 0 || height <= 0) return [];
        return [rectangle(numberAttr(element, 'x'), numberAttr(element, 'y'), width, height)];
      }
      case 'path':
        return svgPathToOperators(element.attrs.get('d') ?? '');
      case 'circle': {
        const r = numberAttr(element, 'r');
        return ellipseOperators(numberAttr(element, 'cx'), numberAttr(element, 'cy'), r, r);
      }
      case 'ellipse':
        return ellipseOperators(numberAttr(element, 'cx'), numberAttr(element, 'cy'), numberAttr(element, 'rx'), numberAttr(element, 'ry'));
      case 'polygon':
        return pointsOperators(element.attrs.get('points'), true);
      case 'polyline':
        return pointsOperators(element.attrs.get('points'), false);
      case 'line':
        return [moveTo(numberAttr(element, 'x1'), numberAttr(element, 'y1')), lineTo(numberAttr(element, 'x2'), numberAttr(element, 'y2'))];
      default:
        return [];
    }
  }

  private async paintElement(element: SvgElement, ops: PDFOperator[]): Promise<void> {
    switch (element.tag) {
      case 'defs':
      case 'clipPath':
      case 'linearGradient':
      case 'radialGradient':
      case 'pattern':
      case 'marker':
      case 'filter':
      case 'title':
      case 'desc':
        return;
      case 'g':
      case 'svg':
      case 'a':
        await this.paintGroup(element, ops);
        return;
      case 'rect':
      case 'path':
      case 'circle':
      case 'ellipse':
      case 'polygon':
        this.paintShape(element, this.shapePath(element), ops);
        return;
      case 'polyline':
      case 'line':
        this.paintShape(element, this.shapePath(element), ops, element.tag === 'polyline' && element.attrs.has('fill'));
        return;
      case 'text':
        this.paintText(element, ops);
        return;
      case 'image':
        await this.paintImage(element, ops);
        return;
      default:
        this.input.warn(`<${element.tag}>(그리지 않음)`);
    }
  }

  private async paintGroup(element: SvgElement, ops: PDFOperator[]): Promise<void> {
    ops.push(pushGraphicsState());
    const transform = element.attrs.get('transform');
    if (transform !== undefined) ops.push(concatTransformationMatrix(...parseTransform(transform)));
    const clipPathElement = this.referenced(element.attrs.get('clip-path'));
    if (clipPathElement !== undefined) ops.push(...this.clipOperators(clipPathElement));
    const opacity = numberAttr(element, 'opacity', 1);
    const state = this.opacityState(opacity, opacity);
    if (state !== undefined) ops.push(state);
    if (element.attrs.has('filter')) this.input.warn('그림자 등 필터(그리지 않음)');
    for (const child of element.children) if (isElement(child)) await this.paintElement(child, ops);
    ops.push(popGraphicsState());
  }

  /** 보이는 글자: 글자마다 그 글꼴 윤곽 Form 을 SVG 자리·크기·배율·색으로 그린다 */
  private paintText(element: SvgElement, ops: PDFOperator[]): void {
    const { glyphs } = this.input;
    const choices = this.input.glyphFonts.get(element) ?? [];
    const chars = [...textContent(element)];
    const size = numberAttr(element, 'font-size', 16);
    const fillRgb = this.fillColor(element) ?? { r: 0, g: 0, b: 0 };
    const opacity = numberAttr(element, 'opacity', 1) * numberAttr(element, 'fill-opacity', 1);
    const strokeRgb = strokeBold(element) ? undefined : parseColor(element.attrs.get('stroke'));
    const strokeEm = strokeRgb !== undefined && size > 0 ? numberAttr(element, 'stroke-width', 1) / size : 0;
    const advances = chars.map((char, i) => {
      const choice = choices[i];
      return choice === undefined ? 0 : glyphs.advance(choice.id, char);
    });
    const naturalWidth = advances.reduce((sum, advance) => sum + advance, 0) * size;

    // textLength(+ lengthAdjust=spacingAndGlyphs): rhwp 가 잰 폭에 글자 폭을 맞춘다(PDF 글꼴 폭이 달라도 자리가 같게)
    const textLength = numberAttr(element, 'textLength', 0);
    const stretch = textLength > 0 && naturalWidth > 0 ? textLength / naturalWidth : 1;
    const anchor = element.attrs.get('text-anchor');
    let x = numberAttr(element, 'x');
    if (anchor === 'middle') x -= (naturalWidth * stretch) / 2;
    if (anchor === 'end') x -= naturalWidth * stretch;
    let y = numberAttr(element, 'y');
    const baseline = element.attrs.get('dominant-baseline');
    if (baseline === 'central' || baseline === 'middle') y += size * 0.35;
    if (baseline === 'hanging' || baseline === 'text-before-edge') y += size * 0.8;
    const transform = parseTransform(element.attrs.get('transform'));

    // 글자 층(글자 배치가 없을 때만 씀): SVG 글자 자리 그대로
    let cursor = x;
    chars.forEach((char, i) => {
      const width = (advances[i] ?? 0) * size * stretch;
      this.svgChars.push({
        char,
        x: transform[0] * cursor + transform[2] * y + transform[4],
        width: Math.max(width * transform[0], 0.01),
        baseline: transform[1] * cursor + transform[3] * y + transform[5],
        size: size * transform[3],
      });
      cursor += width;
    });

    // 투명도 0 글자(rhwp 가 글머리 점을 원으로 그리고 글자는 숨겨 둔 것)는 그리지 않는다 — 글자는 글자 층에 있다
    if (opacity <= 0) return;
    ops.push(pushGraphicsState());
    const state = this.opacityState(opacity, opacity);
    if (state !== undefined) ops.push(state);
    const strokeColor = strokeRgb ?? fillRgb;
    ops.push(setFillingRgbColor(fillRgb.r, fillRgb.g, fillRgb.b), setStrokingRgbColor(strokeColor.r, strokeColor.g, strokeColor.b));
    let advance = 0;
    chars.forEach((char, i) => {
      const choice = choices[i];
      if (choice !== undefined && char.trim().length > 0) {
        const form = glyphs.form(choice.id, char, strokeEm + (choice.syntheticBold ? SYNTHETIC_BOLD_STROKE : 0));
        const skew = choice.syntheticItalic ? SYNTHETIC_ITALIC_SKEW * size : 0;
        // Form 은 em 단위·y 위쪽 → 쪽(y 아래쪽): 가로 size × stretch, 세로 −size
        const matrix = multiply(transform, [size * stretch, 0, skew, -size, x + advance * size * stretch, y]);
        ops.push(pushGraphicsState(), concatTransformationMatrix(...matrix), drawObject(this.xobjectName(form.ref)), popGraphicsState());
      }
      advance += advances[i] ?? 0;
    });
    ops.push(popGraphicsState());
  }

  /**
   * 보이지 않는 글자 층: 글자마다 그 자리 폭에 꼭 맞게(가로 배율 Tz) 둔다 — PDF 뷰어가 글자 사이 틈을 빈칸으로 읽지 않고,
   * 문서의 빈칸만 빈칸 글자로 나온다. 글자 크기는 Tf 로(미리보기는 빈칸 판단을 Tf 크기 기준으로 한다)
   */
  private paintTextLayer(chars: LayerChar[], ops: PDFOperator[]): void {
    if (chars.length === 0) return;
    // 투명도 0 + 보이지 않는 글자(Tr 3) — Type3 글꼴엔 Tr 3 이 듣지 않는 뷰어(미리보기)가 있어 투명도로 가린다
    ops.push(pushGraphicsState());
    const transparent = this.opacityState(0, 0);
    if (transparent !== undefined) ops.push(transparent);
    ops.push(beginText(), setTextRenderingMode(TextRenderingMode.Invisible));
    for (const item of chars) {
      if (item.size <= 0) continue;
      const glyph = this.input.textLayer.glyph(item.char);
      ops.push(
        setFontAndSize(this.fontName(glyph.ref), item.size),
        PDFOperator.of(PDFOperatorNames.SetTextHorizontalScaling, [PDFNumber.of((item.width / item.size) * 100)]),
        setTextMatrix(1, 0, 0, -1, item.x, item.baseline),
        showText(glyph.hex),
      );
    }
    ops.push(endText(), popGraphicsState());
  }

  private async paintImage(element: SvgElement, ops: PDFOperator[]): Promise<void> {
    const { pdf, page, images } = this.input;
    const href = element.attrs.get('href') ?? element.attrs.get('xlink:href') ?? '';
    const match = /^data:image\/(png|jpe?g);base64,(.*)$/s.exec(href);
    if (match === null) {
      this.input.warn(`그림(${/^data:([^;,]+)/.exec(href)?.[1] ?? '바깥 주소'}, 그리지 않음)`);
      return;
    }
    let image = images.get(href);
    if (image === undefined) {
      const bytes = Uint8Array.from(atob(match[2] ?? ''), (char) => char.charCodeAt(0));
      image = match[1] === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      images.set(href, image);
    }
    const x = numberAttr(element, 'x');
    const y = numberAttr(element, 'y');
    const width = numberAttr(element, 'width');
    const height = numberAttr(element, 'height');
    if (width <= 0 || height <= 0) return;
    let name = this.imageNames.get(image);
    if (name === undefined) {
      name = page.node.newXObject('Im', image.ref);
      this.imageNames.set(image, name);
    }
    ops.push(pushGraphicsState());
    const transform = element.attrs.get('transform');
    if (transform !== undefined) ops.push(concatTransformationMatrix(...parseTransform(transform)));
    const opacity = numberAttr(element, 'opacity', 1);
    const state = this.opacityState(opacity, opacity);
    if (state !== undefined) ops.push(state);
    if ((element.attrs.get('preserveAspectRatio') ?? 'xMidYMid meet') !== 'none') {
      // 비율 유지(가운데 맞춤 meet) — rhwp 는 대개 none 을 쓴다
      const scale = Math.min(width / image.width, height / image.height);
      const drawWidth = image.width * scale;
      const drawHeight = image.height * scale;
      ops.push(concatTransformationMatrix(drawWidth, 0, 0, -drawHeight, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2 + drawHeight));
    } else ops.push(concatTransformationMatrix(width, 0, 0, -height, x, y + height));
    ops.push(drawObject(name), popGraphicsState());
  }
}
