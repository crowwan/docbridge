// 기술 검증용 뷰어: @rhwp/core 로 문서를 Canvas 에 그리고, getSelectionRects(왼쪽 끝 보정) 로 하이라이트를 겹친다.
// ?fixture=<이름> 이면 개발 서버의 fixtures/ 에서 문서를 연다(개발·E2E 전용).
import init, { HwpDocument } from '@rhwp/core';
import wasmUrl from '@rhwp/core/rhwp_bg.wasm?url';
import { selectionRects, type SelectionRect, type TextRange } from '../core/highlight-rects.ts';
import type { RenderMetrics, ViewerApi } from './api.ts';

const ZOOM = 1;

const statusEl = document.getElementById('status');
const pagesEl = document.getElementById('pages');

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

// rhwp 는 줄바꿈 계산에 브라우저 글자 폭이 필요하다. WASM 초기화 전에 등록한다.
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

function renderPages(doc: HwpDocument): { pageRenderMs: number[]; pageEls: HTMLElement[] } {
  const scale = ZOOM * window.devicePixelRatio;
  const pageRenderMs: number[] = [];
  const pageEls: HTMLElement[] = [];
  for (let page = 0; page < doc.pageCount(); page += 1) {
    const pageEl = document.createElement('section');
    pageEl.className = 'page';
    pageEl.dataset['testid'] = `page-${page}`;
    pageEl.setAttribute('aria-label', `${page + 1}쪽`);
    const canvas = document.createElement('canvas');
    canvas.dataset['testid'] = `page-canvas-${page}`;
    const started = performance.now();
    doc.renderPageToCanvas(page, canvas, scale);
    pageRenderMs.push(performance.now() - started);
    canvas.style.width = `${canvas.width / window.devicePixelRatio}px`;
    canvas.style.height = `${canvas.height / window.devicePixelRatio}px`;
    pageEl.append(canvas);
    pagesEl?.append(pageEl);
    pageEls.push(pageEl);
  }
  return { pageRenderMs, pageEls };
}

function drawHighlight(doc: HwpDocument, pageEls: HTMLElement[], range: TextRange): SelectionRect[] {
  for (const old of document.querySelectorAll('.highlight')) old.remove();
  const rects = selectionRects(doc, range);
  rects.forEach((rect, i) => {
    const box = document.createElement('div');
    box.className = 'highlight';
    box.dataset['testid'] = `highlight-${i}`;
    box.style.left = `${rect.x * ZOOM}px`;
    box.style.top = `${rect.y * ZOOM}px`;
    box.style.width = `${rect.width * ZOOM}px`;
    box.style.height = `${rect.height * ZOOM}px`;
    pageEls[rect.pageIndex]?.append(box);
  });
  document.querySelector('.highlight')?.scrollIntoView({ block: 'center' });
  return rects;
}

async function start(): Promise<{ metrics: RenderMetrics; doc?: HwpDocument; pageEls: HTMLElement[] }> {
  registerTextMeasure();
  const wasmStarted = performance.now();
  await init({ module_or_path: wasmUrl });
  const wasmInitMs = performance.now() - wasmStarted;

  const fixture = new URLSearchParams(location.search).get('fixture');
  if (fixture === null) {
    setStatus('준비됨');
    return { metrics: { wasmInitMs, parseMs: 0, pageRenderMs: [], pageCount: 0 }, pageEls: [] };
  }
  const response = await fetch(`/fixtures/${encodeURIComponent(fixture)}`);
  if (!response.ok) throw new Error(`${fixture} 을 불러오지 못했습니다 (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const parseStarted = performance.now();
  const doc = new HwpDocument(bytes);
  const parseMs = performance.now() - parseStarted;
  const { pageRenderMs, pageEls } = renderPages(doc);
  setStatus(`${fixture} — ${doc.pageCount()}쪽`);
  return { metrics: { wasmInitMs, parseMs, pageRenderMs, pageCount: doc.pageCount() }, doc, pageEls };
}

const started = start();
const api: ViewerApi = {
  ready: started.then(({ metrics }) => metrics),
  highlight: () => {
    throw new Error('문서가 아직 열리지 않았습니다');
  },
};
window.docbridge = api;

started.then(
  ({ doc, pageEls }) => {
    if (doc) api.highlight = (range) => drawHighlight(doc, pageEls, range);
  },
  (error: unknown) => setStatus(`열 수 없습니다: ${String(error)}`),
);
