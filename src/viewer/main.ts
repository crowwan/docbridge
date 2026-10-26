// docbridge 뷰어: @rhwp/core 로 문서를 Canvas 에 그리고, getSelectionRects(줄 끝 보정) 로 하이라이트와 note 를 겹친다.
// 하이라이트는 쪽 요소 안에 있어서 새 문서를 열거나 새로고침하면 사라진다.
// - ?token=<세션 토큰>: 서버가 연 탭. WebSocket 으로 붙어 서버 요청(load_document 등)을 처리한다
// - ?fixture=<이름>: 개발 서버의 fixtures/ 에서 문서를 연다(개발·E2E 전용)
// - 둘 다 없거나 토큰이 거부되면 "docbridge 가 연 탭이 아닙니다" 화면
import init, { HwpDocument } from '@rhwp/core';
import wasmUrl from '@rhwp/core/rhwp_bg.wasm?url';
import { blockPositionSchema, type Block } from '../core/block-schema.ts';
import { extractBlocks } from '../core/blocks.ts';
import { findInBlocks } from '../core/find-text.ts';
import { selectionRects, type SelectionRect } from '../core/highlight-rects.ts';
import { highlightTargets } from '../core/highlight-targets.ts';
import { errorMessage } from '../shared/errors.ts';
import {
  answerRequest,
  type LoadDocumentResult,
  type RequestMessage,
  type ViewerParams,
  type ViewerResult,
} from '../shared/protocol.ts';
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

/** 하이라이트·note 를 모두 지운다 */
function clearHighlights(): void {
  for (const old of document.querySelectorAll('.highlight, .highlight-note')) old.remove();
}

const NOTE_GAP = 4;

/** note 를 첫 사각형 바로 위(자리가 없으면 아래)에, 왼쪽 끝을 맞춰 붙인다. 쪽 밖으로 나가지 않게 한다 */
function placeNote(pageEl: HTMLElement, rect: SelectionRect, text: string): void {
  const note = document.createElement('div');
  note.className = 'highlight-note';
  note.setAttribute('role', 'note');
  note.dataset['testid'] = 'highlight-note';
  note.textContent = text;
  pageEl.append(note);
  const above = rect.y * ZOOM - note.offsetHeight - NOTE_GAP;
  const top = above >= 0 ? above : (rect.y + rect.height) * ZOOM + NOTE_GAP;
  const left = Math.max(0, Math.min(rect.x * ZOOM, pageEl.clientWidth - note.offsetWidth));
  note.style.top = `${top}px`;
  note.style.left = `${left}px`;
}

/** 이전 하이라이트를 지우고 대상마다 사각형을 그린 뒤, note 를 첫 대상 옆에 붙이고 첫 대상으로 스크롤한다 */
function paintHighlights(pageEls: HTMLElement[], targets: SelectionRect[][], note?: string): void {
  clearHighlights();
  let index = 0;
  let firstBox: HTMLElement | undefined;
  for (const rects of targets) {
    for (const rect of rects) {
      const box = document.createElement('div');
      box.className = 'highlight';
      box.dataset['testid'] = `highlight-${index}`;
      box.style.left = `${rect.x * ZOOM}px`;
      box.style.top = `${rect.y * ZOOM}px`;
      box.style.width = `${rect.width * ZOOM}px`;
      box.style.height = `${rect.height * ZOOM}px`;
      pageEls[rect.pageIndex]?.append(box);
      firstBox ??= box;
      index += 1;
    }
  }
  const first = targets[0]?.[0];
  const firstPage = first === undefined ? undefined : pageEls[first.pageIndex];
  if (first !== undefined && firstPage !== undefined && note !== undefined) placeNote(firstPage, first, note);
  // 첫 대상의 첫 사각형으로(문서 순서상 첫 사각형이 아니다). 바로 옮긴다(부드러운 스크롤 없음):
  // 도구 결과를 받았을 때 이미 그 자리가 보여야 한다
  firstBox?.scrollIntoView({ block: 'center' });
}

/** 대상을 모두 사각형으로 바꾼 뒤에 그린다. 하나라도 틀리면 이전 하이라이트를 그대로 두고 던진다 */
function paintTargets(params: ViewerParams<'highlight'>): ViewerResult<'highlight'> {
  const doc = currentDoc;
  const blocks = openedBlocks();
  if (doc === undefined) throw new Error(NO_VIEWER_DOCUMENT);
  const { rects, pages, warnings } = highlightTargets(doc, blocks, params.targets);
  paintHighlights(currentPageEls, rects, params.note);
  return { pages, ...(warnings.length === 0 ? {} : { warnings }) };
}

const api: ViewerApi = {
  ready: Promise.resolve({ wasmInitMs: 0, parseMs: 0, pageRenderMs: [], pageCount: 0 }),
  highlight: () => {
    throw new Error('문서가 아직 열리지 않았습니다');
  },
};
window.docbridge = api;

let currentDoc: HwpDocument | undefined;
let currentPageEls: HTMLElement[] = [];
/** 서버가 연 문서에서 뽑은 블록. 읽기 전용(v0.1)이라 열 때 한 번 뽑아 둔다 */
let currentBlocks: Block[] | undefined;

/** 문서를 열어 그린다. 이전 문서는 닫는다. rhwp 가 읽지 못하면 던진다 */
function showDocument(bytes: Uint8Array, fileName: string): { doc: HwpDocument; parseMs: number; pageRenderMs: number[] } {
  const parseStarted = performance.now();
  const doc = new HwpDocument(bytes);
  const parseMs = performance.now() - parseStarted;
  currentDoc?.free();
  currentDoc = doc;
  hideNotice();
  // 쪽을 새로 그리면 이전 문서의 하이라이트·note 도 같이 사라진다
  const { pageRenderMs, pageEls } = renderPages(doc);
  currentPageEls = pageEls;
  api.highlight = (range) => {
    const rects = selectionRects(doc, range);
    paintHighlights(pageEls, [rects]);
    return rects;
  };
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
    currentBlocks = extractBlocks(doc);
    return { pageCount: doc.pageCount(), blocks: currentBlocks.map((block) => blockPositionSchema.parse(block)) };
  } catch (error) {
    currentDoc?.free();
    currentDoc = undefined;
    currentBlocks = undefined;
    currentPageEls = [];
    api.highlight = () => {
      throw new Error('문서가 열려 있지 않습니다');
    };
    showNotice('문서를 열 수 없습니다', `${fileName}: ${errorMessage(error)}`);
    setStatus('열 수 없음');
    throw error;
  }
}

function handleRequest(request: RequestMessage): unknown {
  switch (request.method) {
    case 'load_document':
      return loadDocument(request.params.fileName, request.params.data);
    case 'get_blocks':
      return openedBlocks();
    case 'find_text':
      return findInBlocks(openedBlocks(), request.params.query);
    case 'highlight':
      return paintTargets(request.params);
    case 'clear_highlight':
      clearHighlights();
      return {};
    default: {
      // 메서드를 더하고 여기 처리를 빠뜨리면 컴파일 오류가 난다
      const unhandled: never = request;
      throw new Error(`처리하지 않는 요청입니다: ${String(unhandled)}`);
    }
  }
}

const NO_VIEWER_DOCUMENT = '뷰어에 열린 문서가 없습니다. open_document 로 문서를 여세요.';

function openedBlocks(): Block[] {
  if (currentBlocks === undefined) throw new Error(NO_VIEWER_DOCUMENT);
  return currentBlocks;
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
    const response = answerRequest(String(event.data), handleRequest);
    if (response !== undefined) socket.send(JSON.stringify(response));
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
api.ready.catch((error: unknown) => setStatus(`열 수 없습니다: ${errorMessage(error)}`));
