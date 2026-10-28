// #107 기술 검증의 브라우저 쪽(make-pdf-check.ts 가 esbuild 로 묶어 Playwright Chromium 에 띄운다).
// 뷰어와 같이 Canvas 로 글자 폭을 재서 rhwp 가 화면과 같은 줄 배치로 쪽 SVG 를 내게 하고, 후보마다 PDF 를 만든다.
//   a) pdf-lib 로 SVG 를 직접 그리기(글자 = 글꼴 윤곽 + 보이지 않는 글자 층) — src/core/pdf-export.ts (고른 방식)
//   b) jsPDF + svg2pdf.js — SVG DOM 을 그린다(브라우저 전용)
//   c) 그림으로 찍기(쪽 Canvas → JPEG → PDF) — 글자 선택 불가, 대조용
// 글꼴 바이트는 Node 쪽이 시스템 글꼴 폴더에서 읽어 /font/<id> 로 준다(브라우저는 시스템 글꼴 파일을 못 읽는다).
import init from '@rhwp/core';
import { jsPDF } from 'jspdf';
import { svg2pdf } from 'svg2pdf.js';
import { PDFDocument } from 'pdf-lib';
import { openHwpDocument } from '../../src/core/open-document.ts';
import { PX_TO_PT, svgPagesToPdf, type PdfPageSource } from '../../src/core/pdf-export.ts';
import { FontResolver, type FontEntry, type FontLibrary } from '../../src/core/pdf-fonts.ts';
import { parseFontFamilies, parseFontWeight } from '../../src/core/pdf-svg.ts';

export interface CandidateResult {
  /** PDF 바이트(base64) */
  pdf: string;
  /** 만드는 데 걸린 시간(SVG 만들기 제외, 글꼴 받기 포함) */
  ms: number;
  /** 그중 글꼴 바이트 받기 */
  fontMs: number;
  /** 받은 글꼴 바이트 합 */
  fontBytes: number;
  warnings: string[];
  missingGlyphs: number;
}

export interface DocumentRun {
  pageCount: number;
  openMs: number;
  /** renderPageSvg 쪽마다(ms) */
  svgMs: number[];
  svgBytes: number;
  svgs: string[];
  /** getPageTextLayout 쪽마다(JSON) — 글자 층 */
  layouts: string[];
  /** 화면(Canvas, 배율 2) 첫 쪽 PNG(base64) — 사람이 PDF 와 나란히 보려고 */
  screenPng: string;
  a: CandidateResult;
  b: CandidateResult;
  c: CandidateResult;
}

function registerTextMeasure(): void {
  const context = document.createElement('canvas').getContext('2d');
  let lastFont = '';
  Object.assign(globalThis, {
    measureTextWidth(font: string, text: string): number {
      if (!context) return 0;
      if (font !== lastFont) {
        context.font = font;
        lastFont = font;
      }
      return context.measureText(text).width;
    },
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function toBinaryString(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return binary;
}

/** 글꼴 받기 시간·양을 재는 FontLibrary(후보마다 새로 — 받아 둔 글꼴을 다시 쓰지 않는다) */
function fetchingLibrary(faces: FontEntry[], generic: FontLibrary['generic']) {
  const meter = { ms: 0, bytes: 0 };
  const cache = new Map<string, Promise<Uint8Array>>();
  const library: FontLibrary = {
    faces,
    generic,
    load(id) {
      let bytes = cache.get(id);
      if (bytes === undefined) {
        const started = performance.now();
        bytes = fetch(`/font/${encodeURIComponent(id)}`)
          .then((response) => response.arrayBuffer())
          .then((buffer) => {
            meter.ms += performance.now() - started;
            meter.bytes += buffer.byteLength;
            return new Uint8Array(buffer);
          });
        cache.set(id, bytes);
      }
      return bytes;
    },
  };
  return { library, meter };
}

async function candidateA(sources: PdfPageSource[], faces: FontEntry[], generic: FontLibrary['generic']): Promise<CandidateResult> {
  const { library, meter } = fetchingLibrary(faces, generic);
  const started = performance.now();
  const { bytes, warnings, stats } = await svgPagesToPdf(sources, library);
  return { pdf: toBase64(bytes), ms: performance.now() - started, fontMs: meter.ms, fontBytes: meter.bytes, warnings, missingGlyphs: stats.missingGlyphs };
}

async function candidateB(svgs: string[], faces: FontEntry[], generic: FontLibrary['generic']): Promise<CandidateResult> {
  const { library, meter } = fetchingLibrary(faces, generic);
  const resolver = new FontResolver(library);
  const started = performance.now();
  const registered = new Map<string, string>();
  let missingGlyphs = 0;
  let pdf: jsPDF | undefined;
  const host = document.createElement('div');
  document.body.append(host);
  for (const source of svgs) {
    const svg = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
    const width = Number.parseFloat(svg.getAttribute('width') ?? '0') * PX_TO_PT;
    const height = Number.parseFloat(svg.getAttribute('height') ?? '0') * PX_TO_PT;
    const orientation = width > height ? 'landscape' : 'portrait';
    if (pdf === undefined) pdf = new jsPDF({ unit: 'pt', format: [width, height], orientation, compress: true });
    else pdf.addPage([width, height], orientation);
    // svg2pdf 는 font-family 차례에서 jsPDF 에 등록된 첫 이름을 쓴다. 글자별 대체 글꼴은 못 하므로,
    // a) 와 같은 글꼴 고르기 결과로 글자 요소마다 글꼴 이름을 바꿔 둔다(굵기·기울임 합성은 svg2pdf 가 하지 않는다)
    for (const text of svg.querySelectorAll('text')) {
      const char = [...(text.textContent ?? '')][0] ?? '';
      const choice = await resolver.resolve(
        parseFontFamilies(text.getAttribute('font-family') ?? undefined),
        parseFontWeight(text.getAttribute('font-weight') ?? undefined),
        text.getAttribute('font-style') === 'italic',
        char,
      );
      if (choice === undefined) {
        if (char.trim().length > 0) missingGlyphs += 1;
        continue;
      }
      let family = registered.get(choice.id);
      if (family === undefined) {
        family = `F${registered.size + 1}`;
        const file = `${family}.ttf`;
        pdf.addFileToVFS(file, toBinaryString(await library.load(choice.id)));
        pdf.addFont(file, family, 'normal', 'normal', 'Identity-H');
        registered.set(choice.id, family);
      }
      text.setAttribute('font-family', family);
      text.setAttribute('font-weight', 'normal');
      text.removeAttribute('font-style');
    }
    host.replaceChildren(svg);
    await svg2pdf(svg, pdf, { x: 0, y: 0, width, height });
  }
  host.remove();
  const bytes = new Uint8Array(pdf?.output('arraybuffer') ?? new ArrayBuffer(0));
  return { pdf: toBase64(bytes), ms: performance.now() - started, fontMs: meter.ms, fontBytes: meter.bytes, warnings: [], missingGlyphs };
}

async function candidateC(doc: ReturnType<typeof openHwpDocument>, svgs: string[]): Promise<CandidateResult> {
  const started = performance.now();
  const pdf = await PDFDocument.create();
  for (let page = 0; page < doc.pageCount(); page += 1) {
    const canvas = document.createElement('canvas');
    doc.renderPageToCanvas(page, canvas, 2);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (blob === null) throw new Error('쪽 그림을 만들지 못했습니다');
    const image = await pdf.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const svg = new DOMParser().parseFromString(svgs[page] ?? '', 'image/svg+xml').documentElement;
    const width = Number.parseFloat(svg.getAttribute('width') ?? '0') * PX_TO_PT;
    const height = Number.parseFloat(svg.getAttribute('height') ?? '0') * PX_TO_PT;
    pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  }
  const bytes = await pdf.save();
  return { pdf: toBase64(bytes), ms: performance.now() - started, fontMs: 0, fontBytes: 0, warnings: [], missingGlyphs: 0 };
}

let ready: Promise<unknown> | undefined;

async function run(docUrl: string, faces: FontEntry[], generic: FontLibrary['generic']): Promise<DocumentRun> {
  ready ??= (registerTextMeasure(), init({ module_or_path: '/rhwp_bg.wasm' }));
  await ready;
  const bytes = new Uint8Array(await (await fetch(docUrl)).arrayBuffer());
  let started = performance.now();
  const doc = openHwpDocument(bytes);
  const openMs = performance.now() - started;
  const svgs: string[] = [];
  const layouts: string[] = [];
  const svgMs: number[] = [];
  for (let page = 0; page < doc.pageCount(); page += 1) {
    // 뷰어가 서버로 보낼 것: 쪽 SVG + 쪽 글자 배치
    started = performance.now();
    svgs.push(doc.renderPageSvg(page));
    layouts.push(doc.getPageTextLayout(page));
    svgMs.push(performance.now() - started);
  }
  const screen = document.createElement('canvas');
  doc.renderPageToCanvas(0, screen, 2);
  const screenPng = screen.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  const a = await candidateA(
    svgs.map((svg, i) => ({ svg, textLayout: layouts[i] })),
    faces,
    generic,
  );
  const b = await candidateB(svgs, faces, generic);
  const c = await candidateC(doc, svgs);
  const pageCount = doc.pageCount();
  doc.free();
  return { pageCount, openMs, svgMs, svgBytes: svgs.reduce((sum, svg) => sum + svg.length, 0), svgs, layouts, screenPng, a, b, c };
}

Object.assign(window, { pdfCheck: { run } });
