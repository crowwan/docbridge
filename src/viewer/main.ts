// docbridge 뷰어: @rhwp/core 로 문서를 Canvas 에 그리고, getSelectionRects(줄 끝 보정) 로 하이라이트와 note 를 겹친다.
// 하이라이트는 쪽 요소 안에 있어서 새 문서를 열거나 새로고침하면 사라진다.
// - ?token=<세션 토큰>: 서버가 연 탭. WebSocket 으로 붙어 서버 요청(load_document 등)을 처리한다
// - ?fixture=<이름>: 개발 서버의 fixtures/ 에서 문서를 연다(개발·E2E 전용)
// - 둘 다 없거나 토큰이 거부되면 "docbridge 가 연 탭이 아닙니다" 화면
// 편집(SPEC-002)은 core/document-editor.ts 공용 경로로 하고, 여기서는 다시 그리고 바뀐 블록에 초록 테두리를 남긴다.
import init, { HwpDocument } from '@rhwp/core';
import wasmUrl from '@rhwp/core/rhwp_bg.wasm?url';
import type { BlockAnchor } from '../core/block-ids.ts';
import { blockPositionSchema, type Block } from '../core/block-schema.ts';
import { DocumentEditor } from '../core/document-editor.ts';
import type { EditOperation } from '../core/edit-operations.ts';
import { findInBlocks } from '../core/find-text.ts';
import { selectionRects, type SelectionRect } from '../core/highlight-rects.ts';
import { blockBoxes, highlightTargets } from '../core/highlight-targets.ts';
import { exportForSave } from '../core/hwpx-export.ts';
import { createNewDocument, isFirstParagraph, styleSummaries } from '../core/create-document.ts';
import { base64ToBytes } from '../shared/base64.ts';
import { errorMessage } from '../shared/errors.ts';
import {
  answerRequest,
  type CreateDocumentResult,
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

/** 바뀐 블록 표시를 지운다 */
function clearEditMarks(): void {
  for (const old of document.querySelectorAll('.edit-mark')) old.remove();
}

/** 바뀐 블록마다(쪽마다) 블록을 감싸는 초록 테두리를 그리고, 첫 표시가 안 보이면 보이게 스크롤한다 */
function paintEditMarks(rects: SelectionRect[]): void {
  clearEditMarks();
  let first: HTMLElement | undefined;
  rects.forEach((rect, index) => {
    const mark = document.createElement('div');
    mark.className = 'edit-mark';
    mark.dataset['testid'] = `edit-mark-${index}`;
    mark.style.left = `${rect.x * ZOOM}px`;
    mark.style.top = `${rect.y * ZOOM}px`;
    mark.style.width = `${rect.width * ZOOM}px`;
    mark.style.height = `${rect.height * ZOOM}px`;
    currentPageEls[rect.pageIndex]?.append(mark);
    first ??= mark;
  });
  // 바로 옮긴다(움직임 없음). 이미 보이면 그대로 둔다 — 편집한 자리를 보고 있던 화면이 튀지 않게
  first?.scrollIntoView({ block: 'nearest' });
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
  const { doc, blocks } = openedEditor();
  const { rects, pages, warnings } = highlightTargets(doc, blocks, params.targets);
  // 하이라이트를 그리면 바뀐 블록 표시는 지운다(SPEC-002)
  clearEditMarks();
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
let currentFileName = '';
/** 서버가 연 문서의 편집 공용 경로(블록·되돌리기 스냅샷). 편집할 때마다 블록을 다시 뽑는다 */
let currentEditor: DocumentEditor | undefined;

/** 파일 바이트를 rhwp 로 연다. 읽지 못하면 던진다 */
function parseDocument(bytes: Uint8Array): { doc: HwpDocument; parseMs: number } {
  const parseStarted = performance.now();
  const doc = new HwpDocument(bytes);
  return { doc, parseMs: performance.now() - parseStarted };
}

/** 연(또는 만든) 문서를 그린다. 이전 문서는 닫는다 */
function showDocument(doc: HwpDocument, fileName: string): { pageRenderMs: number[] } {
  closeEditor();
  currentDoc?.free();
  currentDoc = doc;
  currentFileName = fileName;
  hideNotice();
  // 쪽을 새로 그리면 이전 문서의 하이라이트·note 도 같이 사라진다. 새 문서는 맨 위부터
  const { pageRenderMs } = redraw(doc, 'top');
  api.highlight = (range) => {
    const rects = selectionRects(doc, range);
    paintHighlights(currentPageEls, [rects]);
    return rects;
  };
  return { pageRenderMs };
}

/** 쪽을 모두 다시 그린다(하이라이트·바뀐 블록 표시도 지워진다). 편집 뒤에는 보던 자리를 그대로, 새 문서는 맨 위로 */
function redraw(doc: HwpDocument, scroll: 'keep' | 'top'): { pageRenderMs: number[] } {
  const scrollY = scroll === 'keep' ? window.scrollY : 0;
  const { pageRenderMs, pageEls } = renderPages(doc);
  currentPageEls = pageEls;
  window.scrollTo(0, scrollY);
  showStatus(doc);
  return { pageRenderMs };
}

/** 이전 문서의 되돌리기 스냅샷을 버린다(서버가 버린 편집 수를 알린다, AC-12) */
function closeEditor(): void {
  currentEditor?.dispose();
  currentEditor = undefined;
}

/** 상태 줄: 마지막 파일 이름(새 문서는 저장할 이름과 "새 문서")과 쪽 수 */
function showStatus(doc: HwpDocument): void {
  setStatus(`${currentFileName}${unsavedNewDocument ? ' (새 문서)' : ''} — ${doc.pageCount()}쪽`);
}

/**
 * 서버가 알려준 저장하지 않은 편집 수(서버 편집 기록이 기준 — 뷰어는 세지 않는다). 0 이 아니면 탭을 닫거나 새로고침할 때
 * 브라우저 확인 창을 띄운다(SPEC-002 새로고침). 서버가 저장·편집·되돌리기 뒤에 edit_state 로 보내고, 새 문서를 열면 0
 */
let unsavedEdits = 0;
/** 한 번도 저장하지 않은 새 문서(SPEC-003). 새로고침하면 사라지므로 편집이 없어도 확인 창을 띄운다. 저장하면 서버가 edit_state 로 끈다 */
let unsavedNewDocument = false;

window.addEventListener('beforeunload', (event) => {
  // 확인 창 문구는 브라우저가 정한다(사이트가 바꿀 수 없다)
  if (unsavedEdits > 0 || unsavedNewDocument) event.preventDefault();
});

/** 서버 편집 상태를 따른다. 저장하면 마지막 파일 이름이 바뀌어 상태 줄도 바꾼다 */
function applyEditState(fileName: string, count: number, newDocument: boolean): void {
  unsavedEdits = count;
  unsavedNewDocument = newDocument;
  currentFileName = fileName;
  if (currentDoc !== undefined) showStatus(currentDoc);
}

function exportHwpx(): ViewerResult<'export_hwpx'> {
  return exportForSave(openedEditor().doc);
}

function loadDocument(fileName: string, data: string): LoadDocumentResult {
  return replaceDocument(fileName, false, () => {
    const { doc } = parseDocument(base64ToBytes(data));
    showDocument(doc, fileName);
    currentEditor = new DocumentEditor(doc);
    return { pageCount: doc.pageCount(), blocks: currentEditor.blocks.map((block) => blockPositionSchema.parse(block)) };
  });
}

/** 새 문서(빈 문서·양식)를 만들어 그린다. 첫 문단은 비어 있어도 블록이다(SPEC-003) */
function createDocument(params: ViewerParams<'create_document'>): CreateDocumentResult {
  return replaceDocument(params.fileName, true, () => {
    const { template } = params;
    const { doc, cleared } = createNewDocument(template === undefined ? undefined : base64ToBytes(template.data), template?.keepContent ?? false);
    showDocument(doc, params.fileName);
    currentEditor = new DocumentEditor(doc, isFirstParagraph);
    return {
      pageCount: doc.pageCount(),
      blocks: currentEditor.blocks.map((block) => blockPositionSchema.parse(block)),
      styles: styleSummaries(doc),
      ...(cleared === undefined ? {} : { cleared: { removedObjects: cleared.removedObjects, keptObjects: cleared.keptObjects } }),
    };
  });
}

/**
 * 열린 문서를 open 이 만든 문서로 바꾼다(열기·새 문서 공용). 실패하면 이전 문서도 닫고 오류 화면을 보여준 뒤 던진다
 * (서버도 열린 문서를 비운다)
 */
function replaceDocument<T>(fileName: string, newDocument: boolean, open: () => T): T {
  unsavedEdits = 0;
  unsavedNewDocument = newDocument;
  try {
    return open();
  } catch (error) {
    unsavedNewDocument = false;
    closeEditor();
    currentDoc?.free();
    currentDoc = undefined;
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
    case 'create_document':
      return createDocument(request.params);
    case 'get_blocks':
      return openedBlocks();
    case 'find_text':
      return findInBlocks(openedBlocks(), request.params.query);
    case 'highlight':
      return paintTargets(request.params);
    case 'clear_highlight':
      clearHighlights();
      return {};
    case 'edit':
      return applyEdit(request.params.operation, request.params.depth, request.params.unsavedEdits);
    case 'undo':
      return undoEdits(request.params.steps, request.params.depth, request.params.unsavedEdits);
    case 'export_hwpx':
      return exportHwpx();
    case 'edit_state':
      applyEditState(request.params.fileName, request.params.unsavedEdits, request.params.newDocument);
      return {};
    default: {
      // 메서드를 더하고 여기 처리를 빠뜨리면 컴파일 오류가 난다
      const unhandled: never = request;
      throw new Error(`처리하지 않는 요청입니다: ${String(unhandled)}`);
    }
  }
}

const NO_VIEWER_DOCUMENT = '뷰어에 열린 문서가 없습니다. open_document 로 문서를 여세요.';

function openedEditor(): DocumentEditor {
  if (currentEditor === undefined) throw new Error(NO_VIEWER_DOCUMENT);
  return currentEditor;
}

function openedBlocks(): Block[] {
  return openedEditor().blocks;
}

/**
 * 편집하고 다시 그린 뒤 바뀐 블록에 표시를 남긴다. 다시 그리기·표시까지 성공해야 편집 기록에 들어간다.
 * 그 사이 던지면 문서는 스냅샷으로 돌아가므로 화면도 되돌린 문서로 다시 그린다
 */
/** unsaved: 편집이 성공한 뒤의 저장하지 않은 편집 수(서버가 계산해 실어 보낸다) */
function applyEdit(operation: EditOperation, depth: number, unsaved: number): ViewerResult<'edit'> {
  const editor = openedEditor();
  let unmarked: BlockAnchor[] = [];
  let drawn = false;
  try {
    const { changed, changes } = editor.edit(operation, depth, (changedBlocks, blocks) => {
      drawn = true;
      redraw(editor.doc, 'keep');
      const marks = blockBoxes(editor.doc, blocks, changedBlocks.map(({ anchor }) => anchor));
      paintEditMarks(marks.boxes);
      unmarked = marks.unmarked;
    });
    unsavedEdits = unsaved;
    return { changed, unmarked, pageCount: editor.doc.pageCount(), ...(changes === undefined ? {} : { changes }) };
  } catch (error) {
    if (drawn) redrawAfterFailure(editor.doc);
    throw error;
  }
}

/** 편집이 되돌려진 뒤 화면을 다시 그린다. 이것도 실패하면 상태 줄에 남기고 원래 오류를 서버에 돌려준다 */
function redrawAfterFailure(doc: HwpDocument): void {
  try {
    redraw(doc, 'keep');
  } catch (error) {
    setStatus(`화면을 다시 그리지 못했습니다: ${errorMessage(error)}`);
  }
}

/** unsaved: steps 를 다 되돌렸을 때의 저장하지 않은 편집 수. 덜 되돌렸으면 서버가 edit_state 로 맞춘다 */
function undoEdits(steps: number, depth: number, unsaved: number): ViewerResult<'undo'> {
  const editor = openedEditor();
  const undone = editor.undo(steps, depth);
  if (undone === steps) unsavedEdits = unsaved;
  if (undone > 0) redraw(editor.doc, 'keep');
  return { undone, pageCount: editor.doc.pageCount() };
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
  const { doc, parseMs } = parseDocument(new Uint8Array(await response.arrayBuffer()));
  const { pageRenderMs } = showDocument(doc, fixture);
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
