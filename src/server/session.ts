// 문서 세션: 지금 열린 문서 하나(마지막 파일 경로와 블록 id 표)를 기억하고,
// 문서가 필요한 도구의 뷰어 요청을 한 곳에서 처리한다.
// 문서 상태의 기준은 뷰어다. 서버는 파일을 읽어 넘기고 id 표만 들고 있다(SPEC-001 구성).
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { BlockIdTable, type BlockPosition } from '../core/block-ids.ts';
import type { LoadDocumentResult, ViewerMethod, ViewerParams, ViewerResult } from '../shared/protocol.ts';
import { errorMessage } from '../shared/errors.ts';
import { ViewerNotConnectedError, type Bridge } from './bridge.ts';
import { log } from './log.ts';

const MB = 1024 * 1024;
/** 이보다 큰 파일은 읽지 않는다 */
export const MAX_FILE_BYTES = 50 * MB;
/** 브라우저를 띄운 뒤 뷰어가 붙기를 기다리는 시간 */
export const VIEWER_CONNECT_TIMEOUT_MS = 30_000;
export const VIEWER_NOT_CONNECTED = '뷰어가 연결되어 있지 않습니다. open_document 로 다시 여세요.';
export const NO_DOCUMENT = '열린 문서가 없습니다. open_document 로 문서를 여세요.';

const OPENABLE_EXTENSIONS = ['.hwp', '.hwpx'];

export interface OpenedDocument {
  /** 절대 경로 */
  path: string;
  fileName: string;
  pageCount: number;
  blockCount: number;
  /** 열 때 뷰어가 준 블록 위치. 새로고침 때 파일이 바뀌었는지 가린다 */
  blocks: BlockPosition[];
  ids: BlockIdTable;
}

const samePositions = (a: BlockPosition[], b: BlockPosition[]) => JSON.stringify(a) === JSON.stringify(b);

export interface OpenResult {
  fileName: string;
  pageCount: number;
  blockCount: number;
  viewerUrl: string;
}

export interface SessionOptions {
  /** 기본 브라우저로 주소를 연다 (테스트에서는 가짜) */
  openBrowser: (url: string) => void;
  /** 검사를 통과한 파일의 바이트를 읽는다 (기본 fs.readFile, 테스트에서 읽기 순서를 조절) */
  readFile?: (path: string) => Promise<Uint8Array>;
}

/** ~/ 로 시작하면 홈 폴더로 바꾸고 절대 경로로 만든다 */
function absolutePath(path: string): string {
  return resolve(path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path);
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
  /** 뷰어에 문서를 보내는 일(열기·새로고침 다시 띄우기)을 한 줄로 세운다. 보낸 순서 = 뷰어에 남는 순서 */
  private loads: Promise<void> = Promise.resolve();

  constructor(bridge: Bridge, options: SessionOptions) {
    this.bridge = bridge;
    this.openBrowser = options.openBrowser;
    this.readFile = options.readFile ?? readFile;
    // 새로고침: 같은 탭이 다시 붙으면 마지막 문서를 다시 보내고 id 표는 그대로 둔다
    bridge.events.on('connected', () => {
      const document = this.current;
      if (document === undefined) return;
      void this.enqueue(() => this.reload(document));
    });
  }

  get document(): OpenedDocument | undefined {
    return this.current;
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
    const path = absolutePath(inputPath);
    const bytes = await readDocumentFile(path, this.readFile);
    const fileName = basename(path);
    return this.enqueue(async () => {
      if (!this.bridge.hasViewer()) await this.launchViewer();
      const loaded = await this.load(fileName, bytes);
      this.current = {
        path,
        fileName,
        pageCount: loaded.pageCount,
        blockCount: loaded.blocks.length,
        blocks: loaded.blocks,
        ids: BlockIdTable.assign(loaded.blocks),
      };
      return { fileName, pageCount: loaded.pageCount, blockCount: loaded.blocks.length, viewerUrl: this.bridge.viewerUrl };
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
    if (!this.bridge.hasViewer()) throw new Error(this.notConnectedMessage());
    if (this.current === undefined) throw new Error(NO_DOCUMENT);
    const params = paramsFor(this.current);
    try {
      return await this.bridge.request(method, params);
    } catch (error) {
      if (error instanceof ViewerNotConnectedError) throw new Error(this.notConnectedMessage());
      throw error;
    }
  }

  private notConnectedMessage(): string {
    return this.current === undefined ? VIEWER_NOT_CONNECTED : `${VIEWER_NOT_CONNECTED} 마지막 파일: ${this.current.path}`;
  }

  private async load(fileName: string, bytes: Uint8Array): Promise<LoadDocumentResult> {
    const data = Buffer.from(bytes).toString('base64');
    try {
      return await this.bridge.request('load_document', { fileName, data });
    } catch (error) {
      if (error instanceof ViewerNotConnectedError) throw new Error(this.notConnectedMessage());
      // 뷰어는 이전 문서를 닫고 오류 화면을 보여준다. 서버도 열린 문서를 비워 맞춘다
      this.current = undefined;
      // 뷰어(rhwp)가 문서를 읽지 못한 이유
      throw new Error(`문서를 열 수 없습니다: ${errorMessage(error)}`);
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

  /** 줄 안에서만 부른다. 줄을 기다리는 사이 다른 문서를 열었으면 보내지 않는다 */
  private async reload(document: OpenedDocument): Promise<void> {
    if (this.current !== document) return;
    let bytes: Uint8Array;
    try {
      bytes = await readDocumentFile(document.path, this.readFile);
    } catch (error) {
      // 파일이 사라졌거나 더는 열 수 없다. 이전 id 표를 들고 있을 이유가 없다
      log(`새로고침: 파일을 다시 읽지 못해 열린 문서를 비웁니다: ${String(error)}`);
      this.current = undefined;
      return;
    }
    try {
      const loaded = await this.load(document.fileName, bytes);
      // 파일이 바뀌어 블록 위치가 달라졌으면 옛 id 표는 다른 블록을 가리킨다
      const changed = !samePositions(document.blocks, loaded.blocks);
      if (changed) log(`새로고침: ${document.fileName} 이 바뀌어 블록 id 를 새로 붙입니다`);
      this.current = {
        ...document,
        pageCount: loaded.pageCount,
        blockCount: loaded.blocks.length,
        blocks: loaded.blocks,
        ids: changed ? BlockIdTable.assign(loaded.blocks) : document.ids,
      };
    } catch (error) {
      log(`새로고침한 뷰어에 문서를 다시 띄우지 못했습니다: ${String(error)}`);
    }
  }
}
