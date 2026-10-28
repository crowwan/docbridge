// docbridge 뷰어: @rhwp/core 로 문서를 Canvas 에 그리고, getSelectionRects(줄 끝 보정) 로 하이라이트와 note 를 겹친다.
// 하이라이트는 쪽 요소 안에 있어서 새 문서를 열거나 새로고침하면 사라진다.
// - ?token=<세션 토큰>: 서버가 연 탭. WebSocket 으로 붙어 서버 요청(load_document 등)을 처리한다
//   &doc=<문서 이름>: 이 탭의 문서(SPEC-007, 문서마다 탭 하나). 연결할 때 서버에 알리고, 새로고침해도 같은 문서로 다시 붙는다.
//   없으면 빈 탭 — 서버가 다음에 여는 문서를 보내며 이름을 알려 주면 주소에 넣는다
// - ?fixture=<이름>: 개발 서버의 fixtures/ 에서 문서를 연다(개발·E2E 전용)
// - 둘 다 없거나 토큰이 거부되면 "docbridge 가 연 탭이 아닙니다" 화면
// 편집(SPEC-002)은 core/document-editor.ts 공용 경로로 하고, 여기서는 다시 그리고 바뀐 블록에 초록 테두리를 남긴다.
// 사람 편집(SPEC-006)은 바로 고치지 않고 서버에 user_edit 로 보낸다. 서버가 Claude 편집과 같은 줄로 처리해 edit 요청으로 돌려준다.
// ⌘Z(윈도우 Ctrl+Z)는 서버 공용 되돌리기(user_undo).
// 더블클릭 글자 고치기(inline-edit.ts)는 고칠 자리·바뀐 범위만(core/edit-spot.ts)을 user_edit 로 보내고, 안 되면 뷰어 아래 알림(toast.ts).
// 끌어 옮기기·오른쪽 클릭 메뉴(block-actions.ts)는 core/block-moves.ts 의 move_blocks·delete_blocks 를 같은 길로 보낸다.
import init, { HwpDocument } from '@rhwp/core';
import wasmUrl from '@rhwp/core/rhwp_bg.wasm?url';
import type { BlockAnchor } from '../core/block-ids.ts';
import { blockPositionSchema, type Block } from '../core/block-schema.ts';
import { DocumentEditor } from '../core/document-editor.ts';
import { openHwpDocument } from '../core/open-document.ts';
import { blockBands, menuEdits } from '../core/block-moves.ts';
import { BLOCK_CHANGED_WHILE_EDITING, bodyBlockAt, editSpotAt, replaceEditAt, spotBox, type EditSpot } from '../core/edit-spot.ts';
import type { EditOperation } from '../core/edit-operations.ts';
import { findInBlocks } from '../core/find-text.ts';
import { selectionRects, type SelectionRect } from '../core/highlight-rects.ts';
import { blockBoxes, highlightTargets } from '../core/highlight-targets.ts';
import { exportForSave } from '../core/hwpx-export.ts';
import { notePlacement, pageTextBoxes, type Box } from '../core/note-placement.ts';
import { createdDocumentResult, createNewDocument } from '../core/create-document.ts';
import { paragraphStyles } from '../core/styles.ts';
import { base64ToBytes } from '../shared/base64.ts';
import { errorMessage } from '../shared/errors.ts';
import {
  answerRequest,
  parseUserResult,
  REQUEST_TIMEOUT_MS,
  RequestTracker,
  userRequestTimeoutMessage,
  userResponseMessageSchema,
  type CreateDocumentResult,
  type UserEdit,
  type UserMethod,
  type UserParams,
  type UserResult,
  type LoadDocumentResult,
  type RequestMessage,
  type ViewerParams,
  type ViewerResult,
} from '../shared/protocol.ts';
import type { RenderMetrics, ViewerApi } from './api.ts';
import { setupBlockActions } from './block-actions.ts';
import { setupInlineEdit } from './inline-edit.ts';
import { showToast } from './toast.ts';

const ZOOM = 1;

const statusEl = document.getElementById('status');
const pagesEl = document.getElementById('pages');
const noticeEl = document.getElementById('notice');
const docNameEl = document.getElementById('doc-name');

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

/** tokens.css 의 px 토큰 값 */
function pxToken(name: string): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
}

const zoomed = (rect: Box): Box => ({ x: rect.x * ZOOM, y: rect.y * ZOOM, width: rect.width * ZOOM, height: rect.height * ZOOM });

/**
 * note 를 문서 글자를 덮지 않는 자리에 붙인다(#51, core/note-placement.ts): 첫 사각형 바로 위 →
 * 쪽 오른쪽 바깥 여백 → 첫 대상 마지막 사각형 아래. firstRects = 첫 대상의 첫 사각형과 같은 쪽 사각형들
 */
function placeNote(pageEl: HTMLElement, firstRects: SelectionRect[], text: string, textBoxes: Box[]): void {
  const first = firstRects[0];
  const last = firstRects.at(-1);
  if (first === undefined || last === undefined) return;
  const note = document.createElement('div');
  note.className = 'highlight-note';
  note.setAttribute('role', 'note');
  note.dataset['testid'] = 'highlight-note';
  note.textContent = text;
  pageEl.append(note);
  // offsetWidth 는 소수 폭을 반올림해, 내림되면 여백 폭으로 다시 걸 때 마지막 글자가 다음 줄로 밀린다("신청기 / 간", #86) → 올림
  const measured = note.getBoundingClientRect();
  const placement = notePlacement(
    zoomed(first),
    zoomed(last),
    { width: Math.ceil(measured.width), height: Math.ceil(measured.height) },
    {
      page: { width: pageEl.clientWidth, height: pageEl.clientHeight },
      rightMargin: document.documentElement.clientWidth - pageEl.getBoundingClientRect().right,
      textBoxes: textBoxes.map(zoomed),
    },
    { gap: pxToken('--note-gap'), minMarginWidth: pxToken('--note-min-width') },
  );
  note.dataset['side'] = placement.side;
  if (placement.side === 'margin') note.style.width = `${placement.width}px`;
  note.style.top = `${placement.y}px`;
  note.style.left = `${placement.x}px`;
}

/**
 * 이전 하이라이트를 지우고 대상마다 사각형을 그린 뒤, note 를 첫 대상 옆에 붙이고 첫 대상으로 스크롤한다.
 * note.textBoxes = 쪽(0부터)의 글자 사각형(note 가 덮지 않을 자리)
 */
function paintHighlights(
  pageEls: HTMLElement[],
  targets: SelectionRect[][],
  note?: { text: string; textBoxes: (pageIndex: number) => Box[] },
): void {
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
  if (first !== undefined && firstPage !== undefined && note !== undefined) {
    const firstRects = (targets[0] ?? []).filter((rect) => rect.pageIndex === first.pageIndex);
    placeNote(firstPage, firstRects, note.text, note.textBoxes(first.pageIndex));
  }
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
  const note = params.note === undefined ? undefined : { text: params.note, textBoxes: (page: number) => pageTextBoxes(doc, page) };
  paintHighlights(currentPageEls, rects, note);
  return { pages, ...(warnings.length === 0 ? {} : { warnings }) };
}

const api: ViewerApi = {
  ready: Promise.resolve({ wasmInitMs: 0, parseMs: 0, pageRenderMs: [], pageCount: 0 }),
  highlight: () => {
    throw new Error('문서가 아직 열리지 않았습니다');
  },
  userEdit: (edit) => requestUserEdit(edit),
};
window.docbridge = api;

let currentDoc: HwpDocument | undefined;
let currentPageEls: HTMLElement[] = [];
let currentFileName = '';
/** 서버가 연 문서의 편집 공용 경로(블록·되돌리기 스냅샷). 편집할 때마다 블록을 다시 뽑는다 */
let currentEditor: DocumentEditor | undefined;

/** 파일 바이트를 rhwp 로 연다(줄 배치가 빠진 문단은 다시 배치, #89). 읽지 못하면 던진다 */
function parseDocument(bytes: Uint8Array): { doc: HwpDocument; parseMs: number } {
  const parseStarted = performance.now();
  const doc = openHwpDocument(bytes);
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
  inlineEdit?.reattach();
  blockActions?.cancel();
  window.scrollTo(0, scrollY);
  showStatus(doc);
  return { pageRenderMs };
}

/** 이전 문서의 되돌리기 스냅샷을 버린다(서버가 버린 편집 수를 알린다, AC-12) */
function closeEditor(): void {
  inlineEdit?.cancel();
  blockActions?.cancel();
  currentEditor?.dispose();
  currentEditor = undefined;
}

/** 상태 줄: 마지막 파일 이름(새 문서는 저장할 이름과 "새 문서")과 쪽 수 */
function showStatus(doc: HwpDocument): void {
  setStatus(`${currentFileName}${unsavedNewDocument ? ' (새 문서)' : ''} — ${doc.pageCount()}쪽`);
  showTitle();
}

/** 이 탭의 문서 이름(SPEC-007). 주소의 &doc= 이고, 서버가 문서를 보내며 알려 준다 */
let docName = new URLSearchParams(location.search).get('doc') ?? '';
/** 탭을 보지 않는 사이 하이라이트·편집이 생겼다(탭 제목 앞 표시). 탭을 보면 지운다 */
let unseenChange = false;

/** 탭 제목 = 파일 이름. 보지 않는 사이 바뀌었으면 앞에 표시(tokens.css --tab-unseen-mark) */
function showTitle(): void {
  const mark = getComputedStyle(document.documentElement).getPropertyValue('--tab-unseen-mark').trim().replace(/^['"]|['"]$/g, '');
  const name = currentFileName === '' ? 'docbridge 뷰어' : currentFileName;
  document.title = unseenChange ? `${mark} ${name}` : name;
}

/** 이 탭의 문서 이름을 정한다: 도구 막대에 보이고, 주소에 넣어 새로고침해도 같은 문서로 다시 붙는다. 빈 이름이면 빈 탭 */
function assignDoc(name: string): void {
  docName = name;
  if (docNameEl) {
    docNameEl.textContent = name;
    docNameEl.hidden = name === '';
  }
  const url = new URL(location.href);
  if (name === '') url.searchParams.delete('doc');
  else url.searchParams.set('doc', name);
  history.replaceState(null, '', url);
}

/** 하이라이트·편집이 생겼다: 탭을 보고 있지 않으면 제목에 표시를 단다 */
function noteChange(): void {
  if (document.visibilityState === 'visible') return;
  unseenChange = true;
  showTitle();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !unseenChange) return;
  unseenChange = false;
  showTitle();
});

/** close_document(SPEC-007): 문서를 닫고 확인 창을 끈다. 탭은 빈 탭으로 남아 다음 문서가 쓴다(스크립트가 열지 않은 탭은 브라우저가 닫게 두지 않는다) */
function closeDocument(): void {
  const closedName = docName;
  closeEditor();
  currentDoc?.free();
  currentDoc = undefined;
  currentPageEls = [];
  currentFileName = '';
  unsavedEdits = 0;
  unsavedNewDocument = false;
  unseenChange = false;
  assignDoc('');
  showNotice('문서를 닫았습니다', `${closedName} 문서를 닫았습니다. 이 탭은 닫아도 됩니다.`);
  setStatus('닫힘');
  showTitle();
}

/**
 * 서버가 알려준 저장하지 않은 편집 수(서버 편집 기록이 기준 — 뷰어는 세지 않는다). 0 이 아니면 탭을 닫거나 새로고침할 때
 * 브라우저 확인 창을 띄운다(SPEC-002 새로고침). 서버가 저장·편집·되돌리기 뒤에 edit_state 로 보내고, 새 문서를 열면 0
 */
let unsavedEdits = 0;
/**
 * 보고 있는 문서의 상태 번호(서버 EditLog.state). 서버가 편집·되돌리기·edit_state 에 실어 보낸 값을 따르고, 문서를 열면 0.
 * 사람 편집(user_edit)에 실어 보내 서버가 그사이 문서가 바뀌었는지 가린다(SPEC-006)
 */
let documentState = 0;
/** 한 번도 저장하지 않은 새 문서(SPEC-003). 새로고침하면 사라지므로 편집이 없어도 확인 창을 띄운다. 저장하면 서버가 edit_state 로 끈다 */
let unsavedNewDocument = false;

window.addEventListener('beforeunload', (event) => {
  // 확인 창 문구는 브라우저가 정한다(사이트가 바꿀 수 없다)
  if (unsavedEdits > 0 || unsavedNewDocument) event.preventDefault();
});

/** 서버 편집 상태를 따른다. 저장하면 마지막 파일 이름이 바뀌어 상태 줄도 바꾼다 */
function applyEditState(fileName: string, count: number, newDocument: boolean, state: number): void {
  unsavedEdits = count;
  documentState = state;
  unsavedNewDocument = newDocument;
  currentFileName = fileName;
  if (currentDoc !== undefined) showStatus(currentDoc);
}

function exportHwpx(): ViewerResult<'export_hwpx'> {
  return exportForSave(openedEditor().doc);
}

function loadDocument(fileName: string, data: string): LoadDocumentResult {
  return replaceDocument(fileName, false, '문서를 열 수 없습니다', () => {
    const { doc } = parseDocument(base64ToBytes(data));
    showDocument(doc, fileName);
    currentEditor = new DocumentEditor(doc);
    return { pageCount: doc.pageCount(), blocks: currentEditor.blocks.map((block) => blockPositionSchema.parse(block)) };
  });
}

/** 새 문서(빈 문서·양식)를 만들어 그린다. 첫 문단은 비어 있어도 블록이다(SPEC-003) */
function createDocument(params: ViewerParams<'create_document'>): CreateDocumentResult {
  // 양식을 못 읽으면 열기와 같은 제목(SPEC-001 문구), 빈 문서를 못 만들면 "새 문서를 만들 수 없습니다"(서버 오류 문구와 같다)
  const failure = params.template === undefined ? '새 문서를 만들 수 없습니다' : '문서를 열 수 없습니다';
  return replaceDocument(params.fileName, true, failure, () => {
    const { template } = params;
    const { doc, cleared } = createNewDocument(template === undefined ? undefined : base64ToBytes(template.data), template?.keepContent ?? false);
    showDocument(doc, params.fileName);
    // 블록이 없는 문서는 첫 문단이 빈 문단 블록이 된다(extractBlocks)
    currentEditor = new DocumentEditor(doc);
    return createdDocumentResult(doc, currentEditor.blocks, cleared);
  });
}

/**
 * 열린 문서를 open 이 만든 문서로 바꾼다(열기·새 문서 공용). 실패하면 이전 문서도 닫고 오류 화면을 보여준 뒤 던진다
 * (서버도 열린 문서를 비운다)
 */
function replaceDocument<T>(fileName: string, newDocument: boolean, failure: string, open: () => T): T {
  unsavedEdits = 0;
  documentState = 0;
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
    showNotice(failure, `${fileName}: ${errorMessage(error)}`);
    setStatus('열 수 없음');
    throw error;
  }
}

function handleRequest(request: RequestMessage): unknown {
  switch (request.method) {
    case 'load_document':
      assignDoc(request.params.doc);
      return loadDocument(request.params.fileName, request.params.data);
    case 'create_document':
      assignDoc(request.params.doc);
      return createDocument(request.params);
    case 'get_blocks':
      return openedBlocks();
    case 'find_text':
      return findInBlocks(openedBlocks(), request.params.query);
    case 'highlight': {
      const result = paintTargets(request.params);
      noteChange();
      return result;
    }
    case 'clear_highlight':
      clearHighlights();
      return {};
    case 'list_styles':
      return paragraphStyles(openedEditor().doc);
    case 'edit': {
      const result = applyEdit(request.params.operation, request.params.depth, request.params.unsavedEdits);
      documentState = request.params.state;
      noteChange();
      return result;
    }
    case 'undo': {
      const result = undoEdits(request.params.steps, request.params.depth, request.params.unsavedEdits);
      // 덜 되돌렸으면 서버가 edit_state 로 맞춘다
      if (result.undone === request.params.steps) documentState = request.params.state;
      if (result.undone > 0) noteChange();
      return result;
    }
    case 'export_hwpx':
      return exportHwpx();
    case 'edit_state':
      applyEditState(request.params.fileName, request.params.unsavedEdits, request.params.newDocument, request.params.state);
      return {};
    case 'close_document':
      closeDocument();
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
    // 열린 입력칸은 닫지 않고 블록 위치를 따라간다(SPEC-006, 같은 블록이 바뀌었으면 적용할 때 거부)
    inlineEdit?.followEdit(changes);
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
  if (undone > 0) {
    // 되돌리기는 블록 위치를 따라갈 수 없어 열린 입력칸을 닫는다(고친 것이 있으면 거부 문구).
    // 다시 그리기가 실패해도 예전 자리를 들고 남지 않게 finally 에서
    try {
      redraw(editor.doc, 'keep');
    } finally {
      inlineEdit?.loseSpot();
    }
  }
  return { undone, pageCount: editor.doc.pageCount() };
}

const DISCONNECTED = 'docbridge 와 연결이 끊겨 고칠 수 없습니다';

/** 서버에 붙은 연결. 끊기면 undefined */
let serverSocket: WebSocket | undefined;
/** 뷰어 → 서버 요청(사람 편집·⌘Z)의 응답을 id 로 기다린다. 늦으면 docbridge 가 답하지 않았다는 문구(서버 마감보다 길다) */
const userRequests = new RequestTracker(REQUEST_TIMEOUT_MS, userRequestTimeoutMessage);

/** 서버에 뷰어 요청을 보내고 응답을 기다린다. 연결이 끊겨 있으면 보내지 않고 DISCONNECTED 로 실패한다 */
function sendUserRequest<M extends UserMethod>(method: M, params: UserParams<M>): Promise<UserResult<M>> {
  const socket = serverSocket;
  if (socket === undefined || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(DISCONNECTED));
  const { id, promise } = userRequests.start(method, parseUserResult[method]);
  socket.send(JSON.stringify({ type: 'user_request', id, method, params }));
  return promise;
}

/** 사람 편집을 서버에 보낸다(보고 있는 문서의 상태 번호와 함께). 다시 그리기·표시는 서버가 보내는 edit 요청에서 한다 */
async function requestUserEdit(edit: UserEdit): Promise<void> {
  openedEditor();
  await sendUserRequest('user_edit', { edit, state: documentState });
}

/**
 * 더블클릭 입력칸 적용: 바뀐 범위만 user_edit 로 보낸다. 입력칸이 열린 동안 Claude 가 그 블록을 바꿨거나(AC-8)
 * 누름틀 값과 바깥에 걸치면 보내지 않고, 서버가 거부하면 그 문구를 뷰어 아래 알림으로 보여 준다
 */
function commitInlineEdit(spot: EditSpot | undefined, text: string, caret: number): void {
  try {
    if (spot === undefined) throw new Error(BLOCK_CHANGED_WHILE_EDITING);
    const edit = replaceEditAt(openedBlocks(), spot, text, caret);
    if (edit !== undefined) requestUserEdit(edit).catch(reportEditFailure);
  } catch (error) {
    reportEditFailure(error);
  }
}

function reportEditFailure(error: unknown): void {
  showToast(errorMessage(error));
}

/** 서버가 연 문서에서만 고친다(개발용 ?fixture 화면은 보기만) */
const inlineEdit =
  pagesEl === null
    ? undefined
    : setupInlineEdit(pagesEl, {
        spotAt: (pageIndex, point) => (currentEditor === undefined ? undefined : editSpotAt(currentEditor.doc, currentEditor.blocks, pageIndex, point)),
        boxOf: (spot) => (currentEditor === undefined ? undefined : spotBox(currentEditor.doc, currentEditor.blocks, spot)),
        pageEls: () => currentPageEls,
        zoom: ZOOM,
        commit: commitInlineEdit,
      });

/** 끌어 옮기기·오른쪽 클릭 메뉴(#60): 서버가 연 문서에서만. 거부되면 뷰어 아래 알림 */
const blockActions =
  pagesEl === null
    ? undefined
    : setupBlockActions(pagesEl, {
        blockAt: (pageIndex, point) => (currentEditor === undefined ? undefined : bodyBlockAt(currentEditor.doc, currentEditor.blocks, pageIndex, point)),
        bands: () => (currentEditor === undefined ? [] : blockBands(currentEditor.doc, currentEditor.blocks)),
        menuEdits: (anchor) => menuEdits(openedBlocks(), anchor),
        pageEls: () => currentPageEls,
        zoom: ZOOM,
        send: (edit) => {
          requestUserEdit(edit).catch(reportEditFailure);
        },
      });

/** 상태 줄에 사람 편집·되돌리기가 안 된 이유를 남긴다(다음 다시 그리기 때 원래 상태 줄로 돌아간다) */
function reportUserFailure(error: unknown): void {
  setStatus(errorMessage(error));
}

// ⌘Z(윈도우 Ctrl+Z): 서버 공용 되돌리기 줄에서 마지막 편집 하나(사람·Claude 상관없이). 입력칸 안에서는 브라우저 기본 동작
window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 'z' || event.shiftKey || event.altKey || !(event.metaKey || event.ctrlKey)) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  if (currentEditor === undefined) return;
  event.preventDefault();
  sendUserRequest('user_undo', {}).catch(reportUserFailure);
});

const NOT_DOCBRIDGE_TAB = 'docbridge 가 연 탭이 아닙니다';
const NOT_DOCBRIDGE_DETAIL = 'Claude 채팅에서 open_document 로 문서를 열면 docbridge 가 이 뷰어를 새로 띄웁니다.';

/** 서버에 붙어 요청을 처리한다. 한 번도 열리지 못하고 닫히면(토큰 거부) 안내 화면 */
function connect(token: string): void {
  // 문서 탭이면 문서 이름을 알린다(새로고침하면 서버가 그 문서를 다시 보낸다, SPEC-007)
  const doc = docName === '' ? '' : `&doc=${encodeURIComponent(docName)}`;
  const socket = new WebSocket(`ws://${location.host}/?token=${encodeURIComponent(token)}${doc}`);
  serverSocket = socket;
  let opened = false;
  setStatus('연결 중…');
  socket.addEventListener('open', () => {
    opened = true;
    setStatus('준비됨');
  });
  socket.addEventListener('close', () => {
    serverSocket = undefined;
    userRequests.failAll(new Error(DISCONNECTED));
    if (!opened) {
      showNotice(NOT_DOCBRIDGE_TAB, NOT_DOCBRIDGE_DETAIL);
      setStatus('연결 거부됨');
      return;
    }
    setStatus('연결이 끊겼습니다. Claude 채팅에서 open_document 로 다시 여세요.');
  });
  socket.addEventListener('message', (event) => {
    // 사람 편집·⌘Z 에 대한 서버 응답
    let data: unknown;
    try {
      data = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const userResponse = userResponseMessageSchema.safeParse(data);
    if (userResponse.success) {
      userRequests.settle(userResponse.data);
      return;
    }
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
