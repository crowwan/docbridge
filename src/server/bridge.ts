// 뷰어 페이지(HTTP)와 뷰어 연결(WebSocket)을 127.0.0.1 한 포트에서 같이 연다.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import {
  RequestTracker,
  responseMessageSchema,
  parseViewerResult,
  requestMessageSchema,
  userRequestMessageSchema,
  type RequestMessage,
  type UserRequestMessage,
  type UserResponseMessage,
  type ViewerMethod,
  type ViewerParams,
  type ViewerResult,
} from '../shared/protocol.ts';
import { errorMessage } from '../shared/errors.ts';
import { EditRejection, USER_REJECTION_MESSAGES, userMessageOf } from '../shared/rejections.ts';
import { log } from './log.ts';

const HOST = '127.0.0.1';
/** 시작 포트가 사용 중이면 다음 포트로 넘어가며 이만큼 시도한다(7790~7799) */
export const PORT_ATTEMPTS = 10;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

export interface BridgeOptions {
  /** 시작 포트. 사용 중이면 다음 포트로 넘어간다. 0 이면 빈 포트를 아무거나 쓴다 (테스트용) */
  port: number;
  /** 시작 포트부터 몇 개까지 시도할지 (기본 PORT_ATTEMPTS) */
  portAttempts?: number;
  /** 빌드된 뷰어 파일이 있는 폴더 */
  viewerDir: string;
  token?: string;
}

export interface Bridge {
  /** 실제로 열린 주소 (127.0.0.1) */
  readonly host: string;
  readonly port: number;
  readonly token: string;
  /** 문서 이름 없는 뷰어 주소(빈 탭 — 다음에 여는 문서가 쓴다) */
  readonly viewerUrl: string;
  /** 문서 doc 의 탭 주소(&doc=d2, SPEC-007). 이 주소로 붙은 탭은 그 문서 탭이고, 새로고침해도 같은 문서로 다시 붙는다 */
  viewerUrlFor(doc: string): string;
  /**
   * 뷰어가 붙으면 'connected', 문서 탭(또는 빈 탭)의 요청을 받던 연결이 끊기면 'disconnected'. 인자는 그 연결의 문서 이름(빈 탭은 undefined)
   */
  readonly events: EventEmitter<BridgeEvents>;
  /** doc 을 주면 그 문서 탭이 붙어 있는지, 없으면 붙은 뷰어(빈 탭 포함)가 하나라도 있는지 */
  hasViewer(doc?: string): boolean;
  /** 문서 이름 없이 붙은 빈 탭(마지막에 붙은 것)을 doc 탭으로 삼는다. 이미 doc 탭이 있으면 true, 빈 탭이 없으면 false */
  claimViewer(doc: string): boolean;
  /** doc 탭 연결을 빈 탭으로 돌린다(문서를 열지 못했거나 닫았을 때 — 그 탭을 다음 문서가 쓴다) */
  releaseViewer(doc: string): void;
  /** doc 탭(마지막으로 붙은 연결)에 요청을 보내고 응답을 기다린다. 탭이 없거나 도중에 끊기면 ViewerNotConnectedError */
  request<M extends ViewerMethod>(doc: string, method: M, params: ViewerParams<M>): Promise<ViewerResult<M>>;
  /**
   * 뷰어가 보낸 요청(사람 편집·⌘Z, SPEC-006)을 handler 로 처리해 그 뷰어에 응답한다. handler 는 보낸 탭의 문서 이름을 받는다.
   * 문서 탭마다 요청을 받는 연결(마지막에 붙은 것)의 것만 처리하고, 같은 문서의 이전 탭·빈 탭의 요청은 INACTIVE_VIEWER 로 거부한다.
   * handler 가 던지면 그 문구로 실패 응답
   */
  serveUserRequests(handler: (doc: string, request: UserRequestMessage) => Promise<unknown>): void;
  close(): Promise<void>;
}

export interface BridgeEvents {
  connected: [doc: string | undefined];
  disconnected: [doc: string | undefined];
}

/** 요청을 받을 뷰어가 없다. 사용자에게 보일 문구는 세션이 마지막 파일 경로와 함께 만든다 */
export class ViewerNotConnectedError extends Error {
  constructor() {
    super('뷰어가 연결되어 있지 않습니다');
    this.name = 'ViewerNotConnectedError';
  }
}

export const INACTIVE_VIEWER = USER_REJECTION_MESSAGES.inactive_tab(undefined);
const NO_USER_HANDLER = USER_REJECTION_MESSAGES.not_ready(undefined);

/** 뷰어 요청 모양(type user_request 와 id)은 맞지만 메서드·입력을 읽지 못한 것 — id 로 오류 응답한다 */
const looseUserRequestSchema = z.object({ type: z.literal('user_request'), id: z.number() });

const searchParam = (url: string | undefined, name: string): string | null => new URL(url ?? '/', `http://${HOST}`).searchParams.get(name);

/** 뷰어 연결 하나: 그 탭의 문서 이름(빈 탭은 undefined)과 그 연결로 보낸 요청(응답은 같은 연결로 온다) */
interface Connection {
  ws: WebSocket;
  doc: string | undefined;
  tracker: RequestTracker;
}

async function serveViewerFile(viewerDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const encoded = new URL(req.url ?? '/', `http://${HOST}`).pathname;
  let pathname: string;
  try {
    // 브라우저는 한글·공백 파일 이름을 %XX 로 보낸다. 디스크 이름과 맞추려면 풀어야 한다
    pathname = decodeURIComponent(encoded);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const relative = normalize(pathname === '/' ? '/index.html' : pathname);
  if (relative.includes('..')) {
    res.writeHead(400).end();
    return;
  }
  try {
    const body = await readFile(join(viewerDir, relative));
    res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(relative)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}

function listen(http: HttpServer, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    http.once('error', onError);
    http.listen(port, HOST, () => {
      http.off('error', onError);
      const address = http.address();
      if (address === null || typeof address === 'string') reject(new Error('주소를 알 수 없습니다'));
      else resolve(address);
    });
  });
}

const isAddressInUse = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';

/** start 부터 attempts 개의 포트를 차례로 시도해 처음 열리는 곳에서 연다 */
async function listenOnFreePort(http: HttpServer, start: number, attempts: number): Promise<AddressInfo> {
  if (start === 0) return listen(http, 0);
  for (let port = start; port < start + attempts; port += 1) {
    try {
      return await listen(http, port);
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      log(`포트 ${port} 사용 중, 다음 포트를 시도합니다`);
    }
  }
  throw new Error(`포트 ${start}~${start + attempts - 1} 이 모두 사용 중입니다. DOCBRIDGE_PORT 로 다른 포트를 정하세요.`);
}

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const token = options.token ?? randomUUID();
  const http = createServer((req, res) => {
    void serveViewerFile(options.viewerDir, req, res);
  });
  const wss = new WebSocketServer({ noServer: true });
  const events = new EventEmitter<BridgeEvents>();
  // 붙은 순서. 문서마다 요청은 그 문서의 마지막에 붙은 연결(새로고침하면 새 연결)이 받는다
  const connections: Connection[] = [];
  const activeFor = (doc: string | undefined) => connections.findLast((connection) => connection.doc === doc);

  const removeConnection = (connection: Connection) => {
    const index = connections.indexOf(connection);
    if (index === -1) return;
    const wasActive = activeFor(connection.doc) === connection;
    connections.splice(index, 1);
    connection.tracker.failAll(new ViewerNotConnectedError());
    if (wasActive) events.emit('disconnected', connection.doc);
  };

  let userHandler: ((doc: string, request: UserRequestMessage) => Promise<unknown>) | undefined;

  /**
   * 뷰어 요청을 처리해 보낸 뷰어에 응답한다. 응답 전에 그 뷰어가 끊겼으면 보내지 않는다.
   * 실패하면 거부 코드로 고른 사람용 문구를 보낸다 — 오류 message 는 Claude 용(블록 id·도구 이름)이라 보내지 않는다(#77).
   * 거부 코드가 없는 실패는 일반 문구로 보낸다. 원래 문구는 거부든 아니든 로그(stderr)에 남긴다
   */
  const answerUser = async (ws: WebSocket, id: number, run: () => Promise<unknown>) => {
    let response: UserResponseMessage;
    try {
      response = { type: 'user_response', id, ok: true, result: await run() };
    } catch (error) {
      // 사람에게는 사람용 문구만 보내므로 원래 문구(블록 id·rhwp 원문 포함)는 로그에 남긴다
      log(error instanceof EditRejection ? `사람 편집 거부(${error.code}): ${error.message}` : `사람 편집 요청이 실패했습니다: ${errorMessage(error)}`);
      const code = error instanceof EditRejection ? { code: error.code } : {};
      response = { type: 'user_response', id, ok: false, error: userMessageOf(error), ...code };
    }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(response));
  };

  const receive = (connection: Connection, data: unknown) => {
    const { ws } = connection;
    const message: unknown = JSON.parse(String(data));
    const userRequest = userRequestMessageSchema.safeParse(message);
    if (userRequest.success) {
      const request = userRequest.data;
      void answerUser(ws, request.id, async () => {
        const { doc } = connection;
        if (doc === undefined || connection !== activeFor(doc)) throw new EditRejection('inactive_tab', INACTIVE_VIEWER);
        if (userHandler === undefined) throw new EditRejection('not_ready', NO_USER_HANDLER);
        return userHandler(doc, request);
      });
      return;
    }
    const looseUser = looseUserRequestSchema.safeParse(message);
    if (looseUser.success) {
      const detail = `서버가 읽을 수 없는 뷰어 요청입니다: ${userRequest.error.message}`;
      void answerUser(ws, looseUser.data.id, () => Promise.reject(new EditRejection('unreadable_request', detail)));
      return;
    }
    const parsed = responseMessageSchema.safeParse(message);
    if (parsed.success) connection.tracker.settle(parsed.data);
    else log(`뷰어 메시지를 읽지 못했습니다: ${parsed.error.message}`);
  };

  // 연결 하나의 오류(잘못된 프레임, 연결 끊김 등)가 'error' 이벤트로 새어 나가면
  // 듣는 곳이 없어 MCP 서버 프로세스 전체가 죽는다. 로그를 남기고 그 연결만 정리한다.
  http.on('upgrade', (req, socket, head) => {
    socket.on('error', (error) => {
      log(`뷰어 연결 소켓 오류: ${error.message}`);
      socket.destroy();
    });
    if (searchParam(req.url, 'token') !== token) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    // 탭 주소의 문서 이름(SPEC-007). 없으면 빈 탭 — 다음에 여는 문서가 쓴다
    const doc = searchParam(req.url, 'doc') || undefined;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connection: Connection = { ws, doc, tracker: new RequestTracker() };
      connections.push(connection);
      ws.on('message', (data) => {
        try {
          receive(connection, data);
        } catch (error) {
          log(`뷰어 메시지 처리 오류: ${String(error)}`);
        }
      });
      ws.on('close', () => removeConnection(connection));
      ws.on('error', (error) => {
        log(`뷰어 WebSocket 오류: ${error.message}`);
        removeConnection(connection);
        ws.terminate();
      });
      events.emit('connected', doc);
    });
  });

  const { address: host, port } = await listenOnFreePort(http, options.port, options.portAttempts ?? PORT_ATTEMPTS);

  const viewerUrl = `http://${HOST}:${port}/?token=${token}`;
  return {
    host,
    port,
    token,
    viewerUrl,
    viewerUrlFor: (doc) => `${viewerUrl}&doc=${encodeURIComponent(doc)}`,
    events,
    hasViewer: (doc) => (doc === undefined ? connections.length > 0 : activeFor(doc) !== undefined),
    claimViewer(doc) {
      if (activeFor(doc) !== undefined) return true;
      const blank = activeFor(undefined);
      if (blank === undefined) return false;
      blank.doc = doc;
      return true;
    },
    releaseViewer(doc) {
      for (const connection of connections) if (connection.doc === doc) connection.doc = undefined;
    },
    serveUserRequests(handler) {
      userHandler = handler;
    },
    request(doc, method, params) {
      const viewer = activeFor(doc);
      if (viewer === undefined) return Promise.reject(new ViewerNotConnectedError());
      const { id, promise } = viewer.tracker.start(method, parseViewerResult[method]);
      // 뷰어가 읽는 스키마로 먼저 확인한다. 맞지 않으면 보내지 않고 바로 실패(뷰어 타임아웃까지 기다리지 않게)
      const message = requestMessageSchema.safeParse({ type: 'request', id, method, params });
      if (!message.success) {
        viewer.tracker.settle({ type: 'response', id, ok: false, error: `뷰어에 보낼 수 없는 요청입니다(${method}): ${message.error.message}` });
        return promise;
      }
      const request: RequestMessage = message.data;
      viewer.ws.send(JSON.stringify(request));
      return promise;
    },
    async close() {
      for (const connection of connections) connection.tracker.failAll(new ViewerNotConnectedError());
      for (const { ws } of connections) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
