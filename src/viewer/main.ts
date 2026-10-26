// docbridge 뷰어: @rhwp/core 로 문서를 Canvas 에 그리고, getSelectionRects(왼쪽 끝 보정) 로 하이라이트를 겹친다.
// - ?token=<세션 토큰>: 서버가 연 탭. WebSocket 으로 붙어 서버 요청(load_document 등)을 처리한다
// - ?fixture=<이름>: 개발 서버의 fixtures/ 에서 문서를 연다(개발·E2E 전용)
// - 둘 다 없거나 토큰이 거부되면 "docbridge 가 연 탭이 아닙니다" 화면
import init, { HwpDocument } from '@rhwp/core';
import wasmUrl from '@rhwp/core/rhwp_bg.wasm?url';
import { blockPositionSchema } from '../core/block-schema.ts';
import { extractBlocks } from '../core/blocks.ts';
import { selectionRects, type SelectionRect, type TextRange } from '../core/highlight-rects.ts';
import { requestMessageSchema, type LoadDocumentResult, type ResponseMessage } from '../shared/protocol.ts';
import type { RenderMetrics, ViewerApi } from './api.ts';

const ZOOM = 1;

const statusEl = document.getElementById('status');
const pagesEl = document.getElementById('pages');
const noticeEl = document.getElementById('notice');

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

/** 문서 대신 안내 화면을 보여준다 (토큰 거부, 문서 오류) */
function showNotice(title: string, detail: string): void {
  pagesEl?.replaceChildren();
  if (!noticeEl) return;
  const heading = document.createElement('h2');
  heading.textContent = title;
  const body = document.createElement('p');
  body.textContent = detail;
  noticeEl.replaceChildren(heading, body);
  noticeEl.hidden = false;
}

function hideNotice(): void {
  if (noticeEl) noticeEl.hidden = true;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
  pagesEl?.replaceChildren();
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

const api: ViewerApi = {
  ready: Promise.resolve({ wasmInitMs: 0, parseMs: 0, pageRenderMs: [], pageCount: 0 }),
  highlight: () => {
    throw new Error('문서가 아직 열리지 않았습니다');
  },
};
window.docbridge = api;

let currentDoc: HwpDocument | undefined;

/** 문서를 열어 그린다. 이전 문서는 닫는다. rhwp 가 읽지 못하면 던진다 */
function showDocument(bytes: Uint8Array, fileName: string): { doc: HwpDocument; parseMs: number; pageRenderMs: number[] } {
  const parseStarted = performance.now();
  const doc = new HwpDocument(bytes);
  const parseMs = performance.now() - parseStarted;
  currentDoc?.free();
  currentDoc = doc;
  hideNotice();
  const { pageRenderMs, pageEls } = renderPages(doc);
  api.highlight = (range) => drawHighlight(doc, pageEls, range);
  setStatus(`${fileName} — ${doc.pageCount()}쪽`);
  return { doc, parseMs, pageRenderMs };
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function loadDocument(fileName: string, data: string): LoadDocumentResult {
  try {
    const { doc } = showDocument(base64ToBytes(data), fileName);
    return { pageCount: doc.pageCount(), blocks: extractBlocks(doc).map((block) => blockPositionSchema.parse(block)) };
  } catch (error) {
    currentDoc?.free();
    currentDoc = undefined;
    api.highlight = () => {
      throw new Error('문서가 열려 있지 않습니다');
    };
    showNotice('문서를 열 수 없습니다', `${fileName}: ${errorText(error)}`);
    setStatus('열 수 없음');
    throw error;
  }
}

const NOT_DOCBRIDGE_TAB = 'docbridge 가 연 탭이 아닙니다';
const NOT_DOCBRIDGE_DETAIL = 'Claude 채팅에서 open_document 로 문서를 열면 docbridge 가 이 뷰어를 새로 띄웁니다.';

/** 서버에 붙어 요청을 처리한다. 한 번도 열리지 못하고 닫히면(토큰 거부) 안내 화면 */
function connect(token: string): void {
  const socket = new WebSocket(`ws://${location.host}/?token=${encodeURIComponent(token)}`);
  let opened = false;
  setStatus('연결 중…');
  socket.addEventListener('open', () => {
    opened = true;
    setStatus('준비됨');
  });
  socket.addEventListener('close', () => {
    if (!opened) {
      showNotice(NOT_DOCBRIDGE_TAB, NOT_DOCBRIDGE_DETAIL);
      setStatus('연결 거부됨');
      return;
    }
    setStatus('연결이 끊겼습니다. Claude 채팅에서 open_document 로 다시 여세요.');
  });
  socket.addEventListener('message', (event) => {
    const parsed = requestMessageSchema.safeParse(JSON.parse(String(event.data)));
    if (!parsed.success) return;
    const { id, params } = parsed.data;
    let response: ResponseMessage;
    try {
      response = { type: 'response', id, ok: true, result: loadDocument(params.fileName, params.data) };
    } catch (error) {
      response = { type: 'response', id, ok: false, error: errorText(error) };
    }
    socket.send(JSON.stringify(response));
  });
}

async function openFixture(fixture: string): Promise<Pick<RenderMetrics, 'parseMs' | 'pageRenderMs' | 'pageCount'>> {
  const response = await fetch(`/fixtures/${encodeURIComponent(fixture)}`);
  if (!response.ok) throw new Error(`${fixture} 을 불러오지 못했습니다 (${response.status})`);
  const { doc, parseMs, pageRenderMs } = showDocument(new Uint8Array(await response.arrayBuffer()), fixture);
  return { parseMs, pageRenderMs, pageCount: doc.pageCount() };
}

async function start(): Promise<RenderMetrics> {
  registerTextMeasure();
  const wasmStarted = performance.now();
  await init({ module_or_path: wasmUrl });
  const wasmInitMs = performance.now() - wasmStarted;

  const params = new URLSearchParams(location.search);
  const fixture = params.get('fixture');
  if (fixture !== null) return { wasmInitMs, ...(await openFixture(fixture)) };

  const token = params.get('token');
  if (token === null || token === '') {
    showNotice(NOT_DOCBRIDGE_TAB, NOT_DOCBRIDGE_DETAIL);
    setStatus('연결 안 됨');
  } else {
    connect(token);
  }
  return { wasmInitMs, parseMs: 0, pageRenderMs: [], pageCount: 0 };
}

api.ready = start();
api.ready.catch((error: unknown) => setStatus(`열 수 없습니다: ${errorText(error)}`));
