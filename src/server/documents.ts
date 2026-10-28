// 여러 문서(SPEC-007): 문서 이름(doc: d1, d2 …) → 문서 세션 표. 문서마다 뷰어 탭 하나·직렬 큐·id 표·편집 기록이 따로다(session.ts).
// 표가 하는 일: 문서 이름 매기기(닫아도 다시 쓰지 않음), 같은 파일 다시 열기는 같은 문서, 8개 상한, "마지막으로 쓴 문서"(doc 을 안 준 도구의 대상),
// 탭 연결·끊김(새로고침이면 그 문서만 다시 띄우고, 다시 붙지 않으면 탭을 닫은 것으로 보고 문서를 뺀다), 다음 도구 결과에 붙일 알림 모으기.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Bridge } from './bridge.ts';
import { absolutePath, realFilePath } from './paths.ts';
import { RELATIVE_TEMPLATE_PATH, requireAbsolutePath, resolveNewDocumentPath } from './save-path.ts';
import {
  DocumentSession,
  NO_DOCUMENT,
  readDocumentFile,
  savingElsewhereMessage,
  unknownDocumentMessage,
  userChangesMessage,
  VIEWER_NOT_CONNECTED,
  type CreateArgs,
  type CreateResult,
  type OpenedDocument,
  type OpenResult,
} from './session.ts';
import { handleUserRequest } from './user-edit.ts';
import { systemFonts, type ExportPdfDeps } from './export-pdf-tool.ts';

/** 한 번에 열 수 있는 문서 수(탭마다 WASM 문서가 따로 있다 — 큰 문서 탭 메모리를 보고 다시 정한다) */
export const MAX_DOCUMENTS = 8;

/**
 * n 번째로 연 문서의 이름(d1, d2 …). 뷰어 주소 &doc= 에 그대로 들어간다.
 * 영문자·숫자만 쓴다 — 퍼센트 인코딩(%)이 생기면 윈도우 cmd 가 주소를 환경 변수로 펼친다(SPEC-004 브라우저 열기)
 */
export function documentName(n: number): string {
  return `d${n}`;
}
export const TOO_MANY_DOCUMENTS = `열린 문서가 ${MAX_DOCUMENTS}개입니다. close_document 로 닫아 주세요.`;
/**
 * 문서 탭 연결이 끊긴 뒤 이만큼 다시 붙지 않으면 사용자가 탭을 닫은 것으로 본다.
 * 새로고침도 연결이 끊겼다가 붙으므로(브라우저는 둘을 가려 알려주지 않는다) 페이지를 다시 띄우는 시간보다 넉넉히
 */
export const TAB_CLOSE_GRACE_MS = 5_000;

/** 사용자가 문서 탭을 닫아 문서를 뺐다(다음 도구 결과에 한 번). lost = 그때 버려진 것(discardNotice) */
export const tabClosedMessage = (doc: string, lost: string | undefined) =>
  `${doc} 탭이 닫혀 문서를 닫았습니다${lost === undefined ? '' : `(${lost})`}`;

export interface SessionsOptions {
  /** 기본 브라우저로 주소를 연다 (테스트에서는 가짜) */
  openBrowser: (url: string) => void;
  /** 검사를 통과한 파일의 바이트를 읽는다 (기본 fs.readFile, 테스트에서 읽기 순서를 조절) */
  readFile?: (path: string) => Promise<Uint8Array>;
  /** 탭이 닫혔다고 보기까지 기다리는 시간(기본 TAB_CLOSE_GRACE_MS) */
  tabCloseGraceMs?: number;
  /** 뷰어 PDF 버튼이 쓸 글꼴(기본: 시스템 글꼴, 테스트: 시험 글꼴) */
  fonts?: ExportPdfDeps['fonts'];
}

/** 다음 도구 결과에 붙일 알림. doc 이 있으면 그 문서의 알림(다른 문서 결과에 붙으면 "d2: " 를 앞에 붙인다) */
interface Notice {
  doc?: string;
  text: string;
}

export interface DocumentSummary {
  doc: string;
  fileName: string;
  /** 마지막 파일(저장 전 새 문서는 처음 저장할 자리) */
  path: string;
  /** 한 번도 저장하지 않은 새 문서(create_document) */
  newDocument?: true;
  pageCount: number;
  unsavedEdits: number;
  /** doc 을 안 준 도구의 대상(마지막으로 쓴 문서) */
  current: boolean;
}

export interface CloseResult {
  doc: string;
  closed: true;
  /** discard: true 로 버린 것 */
  warnings?: string[];
}

function summaryOf(doc: string, document: OpenedDocument, current: boolean): DocumentSummary {
  const { location } = document;
  return {
    doc,
    fileName: document.fileName,
    path: location.kind === 'file' ? location.path : location.savePath,
    ...(location.kind === 'new' ? { newDocument: true } : {}),
    pageCount: document.pageCount,
    unsavedEdits: document.edits.unsavedEdits,
    current,
  };
}

export class DocumentSessions {
  private readonly bridge: Bridge;
  private readonly openBrowser: (url: string) => void;
  private readonly readFile: (path: string) => Promise<Uint8Array>;
  private readonly tabCloseGraceMs: number;
  /** 열린 문서(연 순서). 여는 중인 문서도 든다 */
  private readonly sessions = new Map<string, DocumentSession>();
  /** 쓴 순서(최근 것이 앞). 맨 앞이 "마지막으로 쓴 문서" */
  private recent: string[] = [];
  private nextNumber = 1;
  private notices: Notice[] = [];
  /** 연결이 끊긴 문서 탭: 다시 붙지 않으면 닫는 타이머 */
  private readonly closing = new Map<string, NodeJS.Timeout>();

  constructor(bridge: Bridge, options: SessionsOptions) {
    this.bridge = bridge;
    this.openBrowser = options.openBrowser;
    this.readFile = options.readFile ?? readFile;
    this.tabCloseGraceMs = options.tabCloseGraceMs ?? TAB_CLOSE_GRACE_MS;
    bridge.events.on('connected', (doc) => this.connected(doc));
    bridge.events.on('disconnected', (doc) => this.disconnected(doc));
    // 뷰어가 보낸 사람 편집·⌘Z 는 그 탭 문서의 줄과 편집 기록으로(SPEC-006). 다른 문서와 섞이지 않는다
    bridge.serveUserRequests((doc, request) => {
      const session = this.sessions.get(doc);
      if (session === undefined) return Promise.reject(new Error(unknownDocumentMessage(doc)));
      return handleUserRequest(session, request, options.fonts ?? systemFonts);
    });
  }

  /** 마지막으로 쓴 문서(doc 을 안 준 도구의 대상). 열린 문서가 없으면 undefined */
  get current(): DocumentSession | undefined {
    const [name] = this.recent;
    return name === undefined ? undefined : this.sessions.get(name);
  }

  /** 마지막으로 쓴 문서의 문서(없으면 undefined) */
  get document(): OpenedDocument | undefined {
    return this.current?.document;
  }

  /** 마지막으로 쓴 문서의 되돌릴 수 있는 편집 수(없으면 0) */
  get editCount(): number {
    return this.current?.editCount ?? 0;
  }

  /** 마지막으로 쓴 문서의 저장하지 않은 편집 수(없으면 0) */
  get unsavedEdits(): number {
    return this.current?.unsavedEdits ?? 0;
  }

  /** 마지막으로 쓴 문서에 저장하지 않은 편집이 있는지 */
  get dirty(): boolean {
    return this.current?.dirty ?? false;
  }

  /** 모든 문서의 열기·새로고침 다시 띄우기가 끝날 때까지 기다린다 */
  async ready(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.ready()));
  }

  /**
   * 도구의 대상 문서. doc 을 주면 그 문서(그 문서가 마지막으로 쓴 문서가 된다), 없으면 마지막으로 쓴 문서.
   * 없는 이름이면 list_documents 안내, 열린 문서가 없으면 뷰어 미연결·문서 없음 오류
   */
  get(doc?: string): DocumentSession {
    if (doc !== undefined) {
      const session = this.sessions.get(doc);
      if (session === undefined) throw new Error(unknownDocumentMessage(doc));
      this.use(doc);
      return session;
    }
    const session = this.current;
    if (session === undefined) throw new Error(this.bridge.hasViewer() ? NO_DOCUMENT : VIEWER_NOT_CONNECTED);
    return session;
  }

  /**
   * copy_blocks 의 원본·대상. 두 문서를 모두 확인한 뒤 고른다(없는 이름이 하나라도 있으면 마지막으로 쓴 문서는 그대로).
   * 대상이 마지막으로 쓴 문서, 원본은 그 앞이 된다
   */
  getPair(from: string, to: string): { source: DocumentSession; target: DocumentSession } {
    for (const doc of [from, to]) {
      if (!this.sessions.has(doc)) throw new Error(unknownDocumentMessage(doc));
    }
    return { source: this.get(from), target: this.get(to) };
  }

  /** 파일을 연다. 이미 열린 파일이면 그 문서에 다시 연다(같은 doc), 아니면 새 문서 탭에. 결과 맨 위에 doc */
  async open(inputPath: string): Promise<{ doc: string } & OpenResult> {
    const path = absolutePath(inputPath, process.cwd());
    // 같은 파일은 실제 경로로 가린다(링크·macOS /tmp ↔ /private/tmp). 부른 순간에 본다(읽는 사이 그 문서가 다른 이름으로 저장돼도 그 문서의 줄에 선다)
    const fileKey = await realFilePath(path);
    this.assertNotSavingElsewhere(fileKey, path);
    const read = () => readDocumentFile(path, this.readFile);
    const opened = this.find(fileKey);
    if (opened !== undefined) {
      // 같은 파일 다시 열기: 그 문서의 줄에서 앞 작업(자기 파일 덮어 저장 등)이 끝난 뒤에 읽는다 — 저장 전 내용을 열지 않게(#118)
      this.use(opened.name);
      return { doc: opened.name, ...(await opened.open(path, read, fileKey)) };
    }
    // 새 문서는 읽기에 성공한 뒤에 이름을 매긴다(열 수 없는 파일이 문서 이름을 쓰지 않게)
    const bytes = await read();
    // 읽는 사이 다른 문서가 이 파일로 저장을 시작했을 수 있다. 여기부터 session.open 이 여는 중 표시를 할 때까지 기다림이 없다
    this.assertNotSavingElsewhere(fileKey, path);
    // 읽는 사이 같은 파일이 다른 부름으로 열렸으면 그 문서에 다시 연다(그 줄에서 다시 읽는다)
    const reopened = this.find(fileKey);
    const session = reopened ?? this.add();
    this.use(session.name);
    return { doc: session.name, ...(await session.open(path, reopened === undefined ? () => Promise.resolve(bytes) : read, fileKey)) };
  }

  /** 새 문서를 새 문서 탭에 만든다(SPEC-003). 경로·양식은 문서 이름을 매기기 전에 검사한다 */
  async create(args: CreateArgs): Promise<{ doc: string } & CreateResult> {
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
    const session = this.add();
    this.use(session.name);
    return { doc: session.name, ...(await session.create({ savePath, ...(template === undefined ? {} : { template }) })) };
  }

  /** list_documents: 열린 문서(연 순서). 여는 중인 문서는 빠진다 */
  list(): { documents: DocumentSummary[] } {
    const current = this.current;
    return {
      documents: [...this.sessions.values()].flatMap((session) => {
        const { document } = session;
        return document === undefined ? [] : [summaryOf(session.name, document, session === current)];
      }),
    };
  }

  /** close_document: 저장하지 않은 편집이 있으면 discard 없이는 거부. 닫으면 표에서 빼고 탭은 빈 탭이 된다(다음 문서가 쓴다) */
  async close(doc: string | undefined, discard: boolean): Promise<CloseResult> {
    const session = this.get(doc);
    const warnings = await session.close(discard);
    this.remove(session.name);
    return { doc: session.name, closed: true, ...(warnings.length === 0 ? {} : { warnings }) };
  }

  /**
   * 다음 도구 결과에 붙일 알림을 꺼낸다(꺼내면 비워진다). target 은 그 도구의 대상 문서 —
   * 다른 문서의 알림은 "d2: " 를 앞에 붙인다(문서가 하나뿐이면 붙이지 않는다). 사람이 고친 일은 문서마다 한 줄
   */
  takeNotices(target: string | undefined): string[] {
    const userChanges = [...this.sessions.values()].flatMap((session): Notice[] => {
      const changes = session.takeUserChanges();
      return changes.length === 0 ? [] : [{ doc: session.name, text: userChangesMessage(changes) }];
    });
    return [...this.notices.splice(0), ...userChanges].map(({ doc, text }) => {
      const alone = [...this.sessions.keys()].every((name) => name === doc);
      return doc === undefined || doc === target || alone ? text : `${doc}: ${text}`;
    });
  }

  /** 이 파일(실제 경로)을 열었거나 그 파일로 저장하는 중인, except 가 아닌 문서(저장할 때 본다) */
  private otherDocumentWith(fileKey: string, except: string): { doc: string; saving: boolean } | undefined {
    const opened = this.find(fileKey, except);
    if (opened !== undefined) return { doc: opened.name, saving: false };
    const saver = [...this.sessions.values()].find((session) => session.name !== except && session.savingFileKey === fileKey);
    return saver === undefined ? undefined : { doc: saver.name, saving: true };
  }

  /** 이 파일(실제 경로)이 열린(또는 여는 중인) 문서. except 문서는 빼고 본다 */
  private find(fileKey: string, except?: string): DocumentSession | undefined {
    return [...this.sessions.values()].find((session) => session.name !== except && session.fileKey === fileKey);
  }

  /**
   * 다른 문서가 이 파일로 저장하는 중이면(그 문서의 지금 파일이 아닌데) 열지 않는다. 그대로 열면 저장을 마친 뒤 두 문서가 같은 파일을 가리킨다.
   * 자기 파일에 덮어 저장하는 중이면 같은 문서로 다시 여는 것이라 그 문서의 줄에서 저장 뒤에 연다
   */
  private assertNotSavingElsewhere(fileKey: string, path: string): void {
    const saver = [...this.sessions.values()].find((session) => session.savingFileKey === fileKey && session.fileKey !== fileKey);
    if (saver !== undefined) throw new Error(savingElsewhereMessage(saver.name, path));
  }

  /** 새 문서 이름으로 세션을 더한다. 8개면 거부 */
  private add(): DocumentSession {
    if (this.sessions.size >= MAX_DOCUMENTS) throw new Error(TOO_MANY_DOCUMENTS);
    const name = documentName(this.nextNumber);
    this.nextNumber += 1;
    const session = new DocumentSession({
      name,
      bridge: this.bridge,
      openBrowser: this.openBrowser,
      readFile: this.readFile,
      notify: (text) => this.notices.push({ doc: name, text }),
      gone: () => this.remove(name),
      otherDocumentWith: (fileKey) => this.otherDocumentWith(fileKey, name),
    });
    this.sessions.set(name, session);
    return session;
  }

  private use(doc: string): void {
    this.recent = [doc, ...this.recent.filter((name) => name !== doc)];
  }

  /** 문서를 표에서 뺀다. 탭은 빈 탭으로 돌려 다음 문서가 쓴다 */
  private remove(doc: string): void {
    const session = this.sessions.get(doc);
    if (session === undefined) return;
    session.markClosed();
    this.sessions.delete(doc);
    this.recent = this.recent.filter((name) => name !== doc);
    this.cancelClosing(doc);
    this.bridge.releaseViewer(doc);
  }

  private connected(doc: string | undefined): void {
    if (doc === undefined) return;
    this.cancelClosing(doc);
    const session = this.sessions.get(doc);
    // 닫은 문서 탭을 새로고침했으면 빈 탭으로 둔다(다음 문서가 쓴다)
    if (session === undefined) {
      this.bridge.releaseViewer(doc);
      return;
    }
    session.reconnected();
  }

  /** 문서 탭이 끊겼다: 새로고침이면 곧 다시 붙는다. 정한 시간 안에 붙지 않으면 탭을 닫은 것으로 보고 문서를 빼고 알린다(SPEC-007) */
  private disconnected(doc: string | undefined): void {
    if (doc === undefined || !this.sessions.has(doc) || this.bridge.hasViewer(doc) || this.closing.has(doc)) return;
    const timer = setTimeout(() => {
      this.closing.delete(doc);
      const session = this.sessions.get(doc);
      if (session === undefined || this.bridge.hasViewer(doc)) return;
      const lost = session.discardNotice();
      this.remove(doc);
      this.notices.push({ text: tabClosedMessage(doc, lost) });
    }, this.tabCloseGraceMs);
    // 이 타이머 때문에 프로세스가 끝나지 않는 일은 없게
    timer.unref();
    this.closing.set(doc, timer);
  }

  private cancelClosing(doc: string): void {
    const timer = this.closing.get(doc);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.closing.delete(doc);
  }
}
