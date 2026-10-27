// 문서 세션: 지금 열린 문서 하나(마지막 파일 경로와 블록 id 표)를 기억하고,
// 문서가 필요한 도구의 뷰어 요청을 한 곳에서 처리한다.
// 문서 상태의 기준은 뷰어다. 서버는 파일을 읽어 넘기고 id 표만 들고 있다(SPEC-001 구성).
// 저장하면 저장 경로가 마지막 파일이 되고, 그때 id 표를 기준 표로 떠 둔다. 새로고침하면 마지막 파일과 기준 표로 돌아간다(SPEC-002, ADR 002).
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { anchorsOf, BlockIdTable, tableControlIndex, type BlockPosition } from '../core/block-ids.ts';
import type { ParagraphChanges } from '../core/paragraph-changes.ts';
import type { Block } from '../core/block-schema.ts';
import type { EditOperation } from '../core/edit-operations.ts';
import type { CreateDocumentResult, LoadDocumentResult, ViewerMethod, ViewerParams, ViewerResult } from '../shared/protocol.ts';
import { errorMessage } from '../shared/errors.ts';
import { MAX_DOCUMENT_BYTES, MB } from '../shared/limits.ts';
import { ViewerNotConnectedError, type Bridge } from './bridge.ts';
import { EditLog } from './edit-log.ts';
import { log } from './log.ts';
import { absolutePath } from './paths.ts';
import { RELATIVE_TEMPLATE_PATH, requireAbsolutePath, resolveNewDocumentPath } from './save-path.ts';
import { handleUserRequest } from './user-edit.ts';

/** 이보다 큰 파일은 읽지 않는다 */
export const MAX_FILE_BYTES = MAX_DOCUMENT_BYTES;
/** 브라우저를 띄운 뒤 뷰어가 붙기를 기다리는 시간 */
export const VIEWER_CONNECT_TIMEOUT_MS = 30_000;
export const VIEWER_NOT_CONNECTED = '뷰어가 연결되어 있지 않습니다. open_document 로 다시 여세요.';
export const NO_DOCUMENT = '열린 문서가 없습니다. open_document 로 문서를 여세요.';

const OPENABLE_EXTENSIONS = ['.hwp', '.hwpx'];

/**
 * 문서의 파일 자리.
 * - file: path = 마지막 파일(연 파일, 저장했으면 저장한 파일)의 절대 경로 — 새로고침 때 다시 읽고 미연결 오류에 붙인다.
 *   sourcePath = 원본(open_document 로 연 파일, 새 문서는 처음 저장한 파일) — 저장 기본 이름·상대 경로의 기준, 원본 덮어쓰기 판단
 * - new: 한 번도 저장하지 않은 새 문서(create_document, SPEC-003). 파일이 없고 savePath 는 처음 저장할 자리
 */
export type DocumentLocation = { kind: 'file'; path: string; sourcePath: string } | { kind: 'new'; savePath: string };

export interface OpenedDocument {
  location: DocumentLocation;
  /** 마지막 파일 이름(새 문서는 저장할 이름) */
  fileName: string;
  pageCount: number;
  blockCount: number;
  /** 마지막 파일을 열거나 저장했을 때의 블록 위치. 새로고침 때 파일이 바뀌었는지 가린다 */
  blocks: BlockPosition[];
  ids: BlockIdTable;
  /** 마지막 파일을 열거나 저장했을 때의 id 표 사본(기준 표). 새로고침하면 이것으로 돌아간다(AC-14) */
  savedIds: BlockIdTable;
  /** 편집 기록: 되돌리기 칸(편집 전 id 표 사본)과 저장하지 않은 편집 수. 뷰어 스냅샷과 같은 순서로 쌓인다 */
  edits: EditLog<BlockIdTable>;
}

/** 편집 뒤 바뀐 블록과 그 id */
export interface EditedBlock {
  id: string | undefined;
  block: Block;
}

export interface EditOutcome {
  changed: EditedBlock[];
  /** 바뀌었지만 화면에 표시하지 못한 블록 id(빈 문단 등) */
  unmarked: string[];
  /** 뷰어가 넣은 문단에 새로 준 id(문서 순서) */
  inserted: string[];
  /** 뷰어가 실제로 지운 블록 id(같이 지워진 표·누름틀 포함, 문서 순서) */
  deleted: string[];
}

/**
 * 뷰어가 실제로 넣고 지우고 옮긴 문단·표(ParagraphChanges)대로 id 표를 옮긴다. 서버가 따로 계획하지 않으므로 뷰어 문서와 어긋나지 않는다.
 * 순서는 relocate(core/paragraph-changes.ts)와 같다: 표만 지운 것(컨트롤 번호 큰 것부터) → 지운 문단(뒤에서부터) → 넣은 문단(앞에서부터)
 */
function applyParagraphChanges(ids: BlockIdTable, changes: ParagraphChanges): { inserted: string[]; deleted: string[] } {
  // 옮기기는 id 를 그대로 새 자리로 옮긴다(넣기·지우기와 같이 오지 않는다 — relocate 와 같은 규칙)
  if (changes.moved !== undefined) {
    const { section, start, end, before } = changes.moved;
    ids.paragraphsMoved(section, start, end, before);
    return { inserted: [], deleted: [] };
  }
  const removed = [
    ...changes.deletedParagraphs.flatMap(({ section, paragraph }) => ids.anchorsAt(section, paragraph)),
    ...changes.deletedTables.flatMap(({ section, paragraph, controlIndex }) =>
      ids.anchorsAt(section, paragraph).filter(({ anchor }) => tableControlIndex(anchor) === controlIndex),
    ),
  ];
  const idNumber = (id: string) => Number(id.slice(1));
  const deleted = removed
    .sort((a, b) => a.anchor.section - b.anchor.section || a.anchor.paragraph - b.anchor.paragraph || idNumber(a.id) - idNumber(b.id))
    .map(({ id }) => id);
  for (const table of [...changes.deletedTables].reverse()) ids.tableDeleted(table.section, table.paragraph, table.controlIndex);
  for (const position of [...changes.deletedParagraphs].reverse()) ids.paragraphDeleted(position.section, position.paragraph);
  // 새 id 는 뷰어가 알려 준 블록에(insert_table 이 넣은 문단은 글자가 없어 표 블록에)
  const inserted = changes.inserted.map(({ section, paragraph, part }) => ids.paragraphInserted(section, paragraph, part));
  return { inserted, deleted };
}

const samePositions = (a: BlockPosition[], b: BlockPosition[]) => JSON.stringify(a) === JSON.stringify(b);

export interface OpenResult {
  fileName: string;
  pageCount: number;
  blockCount: number;
  viewerUrl: string;
  /** 이전 문서에서 저장하지 않은 편집을 버렸으면 그 안내 */
  warnings?: string[];
}

export const discardedEditsMessage = (count: number) => `저장하지 않은 편집 ${count}개를 버렸습니다`;
/** 한 번도 저장하지 않은 새 문서는 편집이 없어도(양식 keep_content 등) 되살릴 파일이 없다 */
export const discardedNewDocumentMessage = (fileName: string, edits: number) =>
  `저장하지 않은 새 문서 ${fileName} 을 버렸습니다(편집 ${edits}개)`;
export const newDocumentLostMessage = (savePath: string, edits: number) =>
  `뷰어를 새로고침해서 저장하지 않은 새 문서가 사라졌습니다(${savePath}, 편집 ${edits}개). create_document 로 다시 만드세요.`;

export interface CreateArgs {
  /** 처음 저장할 자리(절대 경로 또는 ~) */
  path: string;
  /** 양식 파일 경로(open_document 와 같은 규칙) */
  template?: string;
  /** 양식 본문을 남긴다(기본 false) */
  keepContent?: boolean;
}

export interface CreateResult {
  /** 처음 저장할 자리(save_document 를 경로 없이 부르면 여기) */
  path: string;
  pageCount: number;
  blockCount: number;
  /** 첫 블록 id(첫 구역 첫 문단 — 비어 있어도 블록). replace_text 로 채우고 그 뒤로 넣는다 */
  firstBlock: string;
  styles: CreateDocumentResult['styles'];
  /** 양식을 줬을 때: 지운 개체·남긴 개체 이름별 수, keep_content 면 keptContent */
  template?:
    | { fileName: string; removedObjects: Record<string, number>; keptObjects: Record<string, number> }
    | { fileName: string; keptContent: true };
  viewerUrl: string;
  warnings?: string[];
}
export const reloadLostEditsMessage = (count: number) => `뷰어를 새로고침해서 저장하지 않은 편집 ${count}개가 사라졌습니다.`;
/** 사람이 화면에서 한 일(편집·⌘Z)을 다음 도구 결과에 한 번 알린다(SPEC-006 AC-9) */
export const userChangesMessage = (changes: string[]) => `사용자가 화면에서 고침: ${changes.join(', ')}`;

/** 편집·되돌리기를 부른 쪽. user = 뷰어에서 사람이(SPEC-006) */
export type EditSource = 'claude' | 'user';


/** 줄 안에서 뷰어에 요청하기(session.exclusive 가 넘긴다) */
export type ViewerSend = <M extends ViewerMethod>(method: M, params: ViewerParams<M>) => Promise<ViewerResult<M>>;

export interface SessionOptions {
  /** 기본 브라우저로 주소를 연다 (테스트에서는 가짜) */
  openBrowser: (url: string) => void;
  /** 검사를 통과한 파일의 바이트를 읽는다 (기본 fs.readFile, 테스트에서 읽기 순서를 조절) */
  readFile?: (path: string) => Promise<Uint8Array>;
}


/** create_document 결과의 양식 요약: 비웠으면 지운 개체·남긴 개체, keep_content 면 본문을 남겼다는 것 */
function templateSummary(fileName: string, cleared: CreateDocumentResult['cleared']): NonNullable<CreateResult['template']> {
  return cleared === undefined ? { fileName, keptContent: true } : { fileName, ...cleared };
}

async function readDocumentFile(path: string, read: (path: string) => Promise<Uint8Array>): Promise<Uint8Array> {
  const extension = extname(path).toLowerCase();
  if (!OPENABLE_EXTENSIONS.includes(extension)) {
    throw new Error(`열 수 없는 파일 형식입니다(${extension || '확장자 없음'}). .hwp, .hwpx 만 열 수 있습니다.`);
  }
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile()) throw new Error(`파일을 찾을 수 없습니다: ${path}`);
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`파일이 너무 큽니다(${Math.ceil(info.size / MB)}MB). ${MAX_FILE_BYTES / MB}MB 까지 열 수 있습니다.`);
  }
  return read(path);
}

export class DocumentSession {
  private readonly bridge: Bridge;
  private readonly openBrowser: (url: string) => void;
  private readonly readFile: (path: string) => Promise<Uint8Array>;
  private current: OpenedDocument | undefined;
  /** 다음 도구 결과에 붙일 알림(새로고침으로 사라진 편집 등). takeNotices 로 꺼내면 비워진다 */
  private notices: string[] = [];
  /** 지난 도구 결과 뒤로 사람이 화면에서 한 일(예: "b11 글자"). takeNotices 가 한 줄로 묶어 꺼낸다 */
  private userChanges: string[] = [];
  /** 뷰어에 문서를 보내는 일(열기·새로고침 다시 띄우기)을 한 줄로 세운다. 보낸 순서 = 뷰어에 남는 순서 */
  private loads: Promise<void> = Promise.resolve();

  constructor(bridge: Bridge, options: SessionOptions) {
    this.bridge = bridge;
    this.openBrowser = options.openBrowser;
    this.readFile = options.readFile ?? readFile;
    // 새로고침: 같은 탭이 다시 붙으면 마지막 파일을 다시 보내고 id 표는 기준 표로 둔다
    bridge.events.on('connected', () => {
      const document = this.current;
      if (document === undefined) return;
      void this.enqueue(() => this.reload(document));
    });
    // 뷰어가 보낸 사람 편집·⌘Z 도 같은 줄과 편집 기록으로(SPEC-006)
    bridge.serveUserRequests((request) => handleUserRequest(this, request));
  }

  get document(): OpenedDocument | undefined {
    return this.current;
  }

  /** 되돌릴 수 있는 편집 수(최대 20). 열린 문서가 없으면 0 */
  get editCount(): number {
    return this.current?.edits.editCount ?? 0;
  }

  /** 마지막으로 열거나 저장한 파일과 지금 문서 사이의 편집 수(저장 때 0). 열린 문서가 없으면 0 */
  get unsavedEdits(): number {
    return this.current?.edits.unsavedEdits ?? 0;
  }

  /** 저장하지 않은 편집이 있는지 */
  get dirty(): boolean {
    return this.current?.edits.dirty ?? false;
  }

  /** 쌓인 알림을 꺼낸다(도구 결과에 붙인다). 꺼내면 비워진다 */
  takeNotices(): string[] {
    const changes = this.userChanges.splice(0);
    return [...this.notices.splice(0), ...(changes.length === 0 ? [] : [userChangesMessage(changes)])];
  }

  /**
   * 저장을 마쳤다(exclusive 안에서 부른다): 저장 경로가 마지막 파일이 되고, 지금 id 표를 기준 표로 떠 두고,
   * 저장하지 않은 편집 수를 0 으로, 뷰어에 편집 상태를 보낸다. blocks 는 저장한 문서의 블록 위치(저장 전 검증으로 다시 연 파일과 같다고 확인한 것)
   */
  async recordSave(document: OpenedDocument, path: string, blocks: BlockPosition[]): Promise<void> {
    // 새 문서는 처음 저장한 파일이 원본이 된다(다음 경로 없는 저장은 <이름>-수정.hwpx, SPEC-003)
    const sourcePath = document.location.kind === 'file' ? document.location.sourcePath : path;
    document.location = { kind: 'file', path, sourcePath };
    document.fileName = basename(path);
    document.blocks = blocks;
    document.blockCount = blocks.length;
    document.savedIds = document.ids.clone();
    document.edits.markSaved();
    await this.pushEditState(document);
  }

  /**
   * 뷰어에 편집 상태(마지막 파일 이름·저장하지 않은 편집 수)를 보낸다. 줄 안에서 부른다(저장 뒤 등. 편집·되돌리기는 요청에 실어 보낸다).
   * 뷰어 확인 창은 서버가 준 값만 따른다.
   * 실패해도(뷰어가 끊김 등) 도구는 실패시키지 않는다 — 확인 창 상태만 어긋나고, 새 뷰어는 0 에서 시작한다
   */
  private async pushEditState(document: OpenedDocument): Promise<void> {
    try {
      await this.send('edit_state', {
        fileName: document.fileName,
        unsavedEdits: document.edits.unsavedEdits,
        newDocument: document.location.kind === 'new',
        state: document.edits.state,
      });
    } catch (error) {
      log(`뷰어에 편집 상태를 보내지 못했습니다: ${String(error)}`);
    }
  }

  /**
   * 열기·새로고침·편집·되돌리기와 겹치지 않게 줄에 세워 task 를 돌린다(저장). 뷰어와 열린 문서가 없으면 그 오류.
   * task 안에서는 send 로 뷰어에 요청한다(requestViewer 는 줄을 기다려 막힌다)
   */
  exclusive<T>(task: (document: OpenedDocument, send: ViewerSend) => Promise<T>): Promise<T> {
    return this.enqueue(async () => task(this.openedDocument(), (method, params) => this.send(method, params)));
  }

  /** 문서를 여는 중이거나 새로고침으로 다시 띄우는 중이면 끝날 때까지 기다린다 */
  ready(): Promise<void> {
    return this.loads;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.loads.then(task);
    // 앞 작업이 실패해도 다음 작업은 돈다
    this.loads = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 문서를 뷰어에 띄운다. 뷰어가 없으면 브라우저로 뷰어 주소를 열고 붙기를 기다린다 */
  async open(inputPath: string): Promise<OpenResult> {
    const path = absolutePath(inputPath, process.cwd());
    const bytes = await readDocumentFile(path, this.readFile);
    const fileName = basename(path);
    return this.enqueue(async () => {
      if (!this.bridge.hasViewer()) await this.launchViewer();
      // 뷰어는 새 문서를 열며 이전 문서와 그 되돌리기 스냅샷을 닫는다(AC-12)
      const discarded = this.discardNotice();
      const loaded = await this.load(fileName, bytes, discarded);
      const ids = BlockIdTable.assign(loaded.blocks);
      this.current = {
        location: { kind: 'file', path, sourcePath: path },
        fileName,
        pageCount: loaded.pageCount,
        blockCount: loaded.blocks.length,
        blocks: loaded.blocks,
        ids,
        savedIds: ids.clone(),
        edits: new EditLog(),
      };
      return {
        fileName,
        pageCount: loaded.pageCount,
        blockCount: loaded.blocks.length,
        viewerUrl: this.bridge.viewerUrl,
        ...(discarded === undefined ? {} : { warnings: [discarded] }),
      };
    });
  }

  /** 지금 문서를 다른 문서로 대신하면 잃는 것: 새 문서(저장 전)면 그 문서, 아니면 저장하지 않은 편집 수. 잃을 것이 없으면 undefined */
  private discardNotice(): string | undefined {
    const document = this.current;
    if (document === undefined) return undefined;
    const edits = document.edits.unsavedEdits;
    if (document.location.kind === 'new') return discardedNewDocumentMessage(document.fileName, edits);
    return edits === 0 ? undefined : discardedEditsMessage(edits);
  }

  /**
   * 새 문서를 뷰어에 띄운다(SPEC-003). 경로·양식은 줄에 서기 전에 검사한다(이미 있는 파일·상대 경로·양식을 못 읽음).
   * 새 문서 바이트는 뷰어가 rhwp 로 만든다 — 서버는 양식 바이트만 보내고 파일 없는 문서(location new)로 기억한다
   */
  async create(args: CreateArgs): Promise<CreateResult> {
    const savePath = await resolveNewDocumentPath(args.path);
    // 양식도 새 문서 경로처럼 절대 경로나 ~ 만(서버 작업 폴더는 사용자가 모른다)
    const templatePath = args.template === undefined ? undefined : requireAbsolutePath(args.template, RELATIVE_TEMPLATE_PATH);
    const template =
      templatePath === undefined
        ? undefined
        : {
            fileName: basename(templatePath),
            data: Buffer.from(await readDocumentFile(templatePath, this.readFile)).toString('base64'),
            keepContent: args.keepContent ?? false,
          };
    const fileName = basename(savePath);
    return this.enqueue(async () => {
      if (!this.bridge.hasViewer()) await this.launchViewer();
      const discarded = this.discardNotice();
      const failure = template === undefined ? '새 문서를 만들 수 없습니다' : '문서를 열 수 없습니다';
      const created = await this.present(
        () => this.bridge.request('create_document', { fileName, ...(template === undefined ? {} : { template }) }),
        failure,
        discarded,
      );
      const ids = BlockIdTable.assign(created.blocks);
      // 블록이 없는 문서는 뷰어가 첫 문단을 빈 문단 블록으로 남기므로 늘 하나는 있다(keep_content 면 양식의 첫 블록)
      const [first] = anchorsOf(created.blocks);
      const firstBlock = first === undefined ? undefined : ids.idAt(first);
      if (firstBlock === undefined) throw new Error('새 문서의 첫 블록을 찾지 못했습니다.');
      this.current = {
        location: { kind: 'new', savePath },
        fileName,
        pageCount: created.pageCount,
        blockCount: created.blocks.length,
        blocks: created.blocks,
        ids,
        savedIds: ids.clone(),
        edits: new EditLog(),
      };
      return {
        path: savePath,
        pageCount: created.pageCount,
        blockCount: created.blocks.length,
        firstBlock,
        styles: created.styles,
        ...(template === undefined ? {} : { template: templateSummary(template.fileName, created.cleared) }),
        viewerUrl: this.bridge.viewerUrl,
        ...(discarded === undefined ? {} : { warnings: [discarded] }),
      };
    });
  }

  /**
   * 문서가 필요한 도구가 뷰어에 요청하는 공용 경로.
   * 뷰어가 없으면 스펙 문구와 마지막 파일 경로로, 뷰어는 있는데 열린 문서가 없으면(열기 실패 뒤) 문서 없음으로 실패한다
   */
  async requestViewer<M extends ViewerMethod>(method: M, params: ViewerParams<M>): Promise<ViewerResult<M>> {
    return this.requestWithDocument(method, () => params);
  }

  /** requestViewer 와 같되, 입력을 지금 열린 문서(id 표)로 만든다. paramsFor 가 던지면(없는 id 등) 그 오류로 끝난다 */
  async requestWithDocument<M extends ViewerMethod>(
    method: M,
    paramsFor: (document: OpenedDocument) => ViewerParams<M>,
  ): Promise<ViewerResult<M>> {
    await this.ready();
    const document = this.openedDocument();
    return this.send(method, paramsFor(document));
  }

  /**
   * 편집 공용 경로(SPEC-002). 편집은 줄에 세워 하나씩 한다(편집 전 id 표 사본과 뷰어 스냅샷이 같은 순서로 쌓여야 한다).
   * 뷰어가 스냅샷 → 편집 → 다시 그리기 → 블록 다시 뽑기 → 바뀐 블록 표시를 하고, 성공하면 서버는
   * 뷰어가 돌려준 "실제로 넣고 지운 문단·표"(changes)대로 id 표를 옮기고(넣기·지우기, #20), updateIds 를 부른 뒤 편집 전 id 표를 되돌리기 칸에 쌓는다.
   * 뷰어가 실패하면(스냅샷으로 되돌림) id 표·기록은 그대로다. 결과는 바뀐 블록과 그 id(새 블록은 새 id), 넣고 지운 id.
   * 요청에 서버 편집 순번을 실어 보낸다: 앞 편집 결과를 못 받았으면(타임아웃 등 — 뷰어는 적용했을 수 있다) 뷰어가 어긋남으로 거부한다
   */
  async edit(
    /**
     * 지금 문서로 편집과 그 이름(되돌리기 결과에 보인다)을 만든다. 던지면(없는 id·거부) 뷰어에 보내지 않는다.
     * notice 를 주면(사람 편집) 성공했을 때 다음 도구 결과 알림에 넣는다
     */
    prepare: (document: OpenedDocument) => { label: string; operation: EditOperation; notice?: string },
    updateIds: (ids: BlockIdTable) => void = () => undefined,
  ): Promise<EditOutcome> {
    return this.enqueue(async () => {
      const document = this.openedDocument();
      const { label, operation, notice } = prepare(document);
      const before = document.ids.clone();
      const { changed, unmarked, pageCount, changes } = await this.send('edit', {
        operation,
        depth: document.edits.depth,
        unsavedEdits: document.edits.unsavedAfterRecord(),
        state: document.edits.stateAfterRecord(),
      });
      const { inserted, deleted } = changes === undefined ? { inserted: [], deleted: [] } : applyParagraphChanges(document.ids, changes);
      updateIds(document.ids);
      document.edits.record(label, before);
      document.pageCount = pageCount;
      if (notice !== undefined) this.userChanges.push(notice);
      const { ids } = document;
      return {
        changed: changed.map(({ anchor, block }) => ({ id: ids.idAt(anchor), block })),
        unmarked: unmarked.flatMap((anchor) => ids.idAt(anchor) ?? []),
        inserted,
        deleted,
      };
    });
  }

  /**
   * steps 만큼(있는 만큼만) 되돌린다: 뷰어가 스냅샷으로, 서버는 id 표를 그 편집 전으로.
   * 되돌린 편집 이름(최근 것부터). 되돌릴 것이 없으면 빈 배열. 사람이(⌘Z) 되돌렸으면 다음 도구 결과에 알린다
   */
  async undo(steps: number, source: EditSource = 'claude'): Promise<string[]> {
    return this.enqueue(async () => {
      const document = this.openedDocument();
      const available = Math.min(steps, document.edits.editCount);
      if (available === 0) return [];
      const { undone, pageCount } = await this.send('undo', {
        steps: available,
        depth: document.edits.depth,
        unsavedEdits: document.edits.unsavedAfterUndo(available),
        state: document.edits.stateAfterUndo(available),
      });
      document.pageCount = pageCount;
      // 뷰어가 되돌린 만큼만(뷰어 스냅샷이 서버 기록보다 적을 수 있다 — 새로고침 뒤 등)
      const taken = document.edits.undo(undone);
      if (taken === undefined) return [];
      document.ids = taken.state;
      // 뷰어가 덜 되돌렸으면 요청에 실은 값이 틀리다 — 따로 맞춘다
      if (undone !== available) await this.pushEditState(document);
      if (source === 'user') this.userChanges.push(`되돌림(${taken.labels.join(', ')})`);
      return taken.labels;
    });
  }

  /** 뷰어가 붙어 있고 열린 문서가 있으면 그 문서. 아니면 미연결(마지막 파일)·문서 없음 오류 */
  private openedDocument(): OpenedDocument {
    if (!this.bridge.hasViewer()) throw new Error(this.notConnectedMessage());
    if (this.current === undefined) throw new Error(NO_DOCUMENT);
    return this.current;
  }

  private async send<M extends ViewerMethod>(method: M, params: ViewerParams<M>): Promise<ViewerResult<M>> {
    try {
      return await this.bridge.request(method, params);
    } catch (error) {
      if (error instanceof ViewerNotConnectedError) throw new Error(this.notConnectedMessage());
      throw error;
    }
  }

  private notConnectedMessage(): string {
    const location = this.current?.location;
    if (location === undefined) return VIEWER_NOT_CONNECTED;
    return location.kind === 'file'
      ? `${VIEWER_NOT_CONNECTED} 마지막 파일: ${location.path}`
      : `${VIEWER_NOT_CONNECTED} 저장하지 않은 새 문서: ${location.savePath}`;
  }

  /** discarded: 이 문서를 띄우며 잃는 것(discardNotice). 열지 못해도 이전 문서는 닫히므로 오류에 붙여 알린다 */
  private load(fileName: string, bytes: Uint8Array, discarded?: string): Promise<LoadDocumentResult> {
    const data = Buffer.from(bytes).toString('base64');
    return this.present(() => this.bridge.request('load_document', { fileName, data }), '문서를 열 수 없습니다', discarded);
  }

  /**
   * 뷰어에 문서를 바꿔 띄우는 요청(열기·새 문서). 뷰어가 실패하면 이전 문서도 닫고 오류 화면을 보여주므로 서버도 열린 문서를 비우고,
   * failure: <뷰어(rhwp)가 문서를 읽거나 만들지 못한 이유>(버린 편집 수) 로 던진다
   */
  private async present<T>(request: () => Promise<T>, failure: string, discarded: string | undefined): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (error instanceof ViewerNotConnectedError) throw new Error(this.notConnectedMessage());
      this.current = undefined;
      const lost = discarded === undefined ? '' : ` (${discarded})`;
      throw new Error(`${failure}: ${errorMessage(error)}${lost}`);
    }
  }

  private launchViewer(): Promise<void> {
    const url = this.bridge.viewerUrl;
    const connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.bridge.events.off('connected', onConnected);
        reject(
          new Error(
            `뷰어가 ${VIEWER_CONNECT_TIMEOUT_MS / 1000}초 안에 연결되지 않았습니다. 브라우저에서 ${url} 을 열고 다시 시도하세요.`,
          ),
        );
      }, VIEWER_CONNECT_TIMEOUT_MS);
      const onConnected = () => {
        clearTimeout(timer);
        resolve();
      };
      this.bridge.events.once('connected', onConnected);
    });
    try {
      this.openBrowser(url);
    } catch (error) {
      log(`브라우저를 열지 못했습니다: ${String(error)}`);
    }
    return connected;
  }

  /**
   * 줄 안에서만 부른다. 줄을 기다리는 사이 다른 문서를 열었으면 보내지 않는다.
   * 새로 붙은 뷰어는 빈 탭이라 저장하지 않은 편집과 되돌리기 스냅샷이 이미 사라졌다. 마지막 파일을 다시 보내고,
   * id 표를 기준 표(그 파일을 열거나 저장했을 때)로, 편집 기록을 새로 만들고, 사라진 편집 수를 다음 도구 결과에 알린다(AC-14)
   */
  private async reload(document: OpenedDocument): Promise<void> {
    if (this.current !== document) return;
    const lost = document.edits.unsavedEdits;
    const { location } = document;
    if (location.kind === 'new') {
      // 한 번도 저장하지 않은 새 문서는 다시 띄울 파일이 없다 — 새 뷰어는 빈 탭이고 문서는 사라졌다(SPEC-003 AC-8)
      this.current = undefined;
      this.notices.push(newDocumentLostMessage(location.savePath, lost));
      return;
    }
    // 알림은 편집이 정말 사라졌을 때(다시 띄우기 성공, 또는 파일이 없거나 읽지 못해 문서를 비움) 한 번만. 띄우다 끊기면 다음 새로고침이 다시 센다
    const notifyLost = () => {
      if (lost > 0) this.notices.push(reloadLostEditsMessage(lost));
    };
    let bytes: Uint8Array;
    try {
      bytes = await readDocumentFile(location.path, this.readFile);
    } catch (error) {
      // 파일이 사라졌거나 더는 열 수 없다. 이전 id 표를 들고 있을 이유가 없다
      log(`새로고침: 파일을 다시 읽지 못해 열린 문서를 비웁니다: ${String(error)}`);
      this.current = undefined;
      notifyLost();
      return;
    }
    try {
      const loaded = await this.load(document.fileName, bytes);
      // 파일이 바뀌어 블록 위치가 달라졌으면 옛 id 표는 다른 블록을 가리킨다
      const changed = !samePositions(document.blocks, loaded.blocks);
      if (changed) log(`새로고침: ${document.fileName} 이 바뀌어 블록 id 를 새로 붙입니다`);
      // 편집이 없었으면 지금 표가 곧 기준 표다(같은 표를 그대로 둔다)
      const ids = changed ? BlockIdTable.assign(loaded.blocks) : lost === 0 ? document.ids : document.savedIds.clone();
      this.current = {
        ...document,
        pageCount: loaded.pageCount,
        blockCount: loaded.blocks.length,
        blocks: loaded.blocks,
        ids,
        savedIds: changed ? ids.clone() : document.savedIds,
        edits: new EditLog(),
      };
      notifyLost();
    } catch (error) {
      log(`새로고침한 뷰어에 문서를 다시 띄우지 못했습니다: ${String(error)}`);
      // 뷰어(rhwp)가 읽지 못해 문서를 비웠으면 편집도 끝내 사라졌다. 연결이 끊긴 것이면(문서는 그대로) 다음 새로고침이 센다
      if (this.current === undefined) notifyLost();
    }
  }
}
