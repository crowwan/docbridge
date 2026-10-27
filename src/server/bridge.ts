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
  readonly viewerUrl: string;
  /** 뷰어가 붙으면 'connected', 요청을 받던 뷰어가 끊기면 'disconnected' */
  readonly events: EventEmitter<BridgeEvents>;
  hasViewer(): boolean;
  /** 마지막으로 붙은 뷰어에 요청을 보내고 응답을 기다린다. 뷰어가 없거나 도중에 끊기면 ViewerNotConnectedError */
  request<M extends ViewerMethod>(method: M, params: ViewerParams<M>): Promise<ViewerResult<M>>;
  /**
   * 뷰어가 보낸 요청(사람 편집·⌘Z, SPEC-006)을 handler 로 처리해 그 뷰어에 응답한다. 요청을 받는 뷰어(마지막에 붙은 탭)의 것만 처리하고
   * 다른 탭의 요청은 INACTIVE_VIEWER 로 거부한다. handler 가 던지면 그 문구로 실패 응답
   */
  serveUserRequests(handler: (request: UserRequestMessage) => Promise<unknown>): void;
  close(): Promise<void>;
}

export interface BridgeEvents {
  connected: [];
  disconnected: [];
}

/** 요청을 받을 뷰어가 없다. 사용자에게 보일 문구는 세션이 마지막 파일 경로와 함께 만든다 */
export class ViewerNotConnectedError extends Error {
  constructor() {
    super('뷰어가 연결되어 있지 않습니다');
    this.name = 'ViewerNotConnectedError';
  }
}

export const INACTIVE_VIEWER = '다른 뷰어 탭이 docbridge 에 붙어 있어 이 탭에서는 고칠 수 없습니다. 마지막에 연 탭에서 고치세요.';
const NO_USER_HANDLER = 'docbridge 가 뷰어 편집을 받을 준비가 되지 않았습니다.';

/** 뷰어 요청 모양(type user_request 와 id)은 맞지만 메서드·입력을 읽지 못한 것 — id 로 오류 응답한다 */
const looseUserRequestSchema = z.object({ type: z.literal('user_request'), id: z.number() });

function tokenOf(url: string | undefined): string | null {
  return new URL(url ?? '/', `http://${HOST}`).searchParams.get('token');
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
  const tracker = new RequestTracker();
  // 붙은 순서. 요청은 마지막에 붙은 뷰어(새로고침하면 새 연결)가 받는다
  const viewers: WebSocket[] = [];
  const activeViewer = () => viewers.at(-1);

  const removeViewer = (ws: WebSocket) => {
    const index = viewers.indexOf(ws);
    if (index === -1) return;
    const wasActive = index === viewers.length - 1;
    viewers.splice(index, 1);
    if (!wasActive) return;
    tracker.failAll(new ViewerNotConnectedError());
    events.emit('disconnected');
  };

  let userHandler: ((request: UserRequestMessage) => Promise<unknown>) | undefined;

  /** 뷰어 요청을 처리해 보낸 뷰어에 응답한다. 응답 전에 그 뷰어가 끊겼으면 보내지 않는다 */
  const answerUser = async (ws: WebSocket, id: number, run: () => Promise<unknown>) => {
    let response: UserResponseMessage;
    try {
      response = { type: 'user_response', id, ok: true, result: await run() };
    } catch (error) {
      response = { type: 'user_response', id, ok: false, error: errorMessage(error) };
    }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(response));
  };

  const receive = (ws: WebSocket, data: unknown) => {
    const message: unknown = JSON.parse(String(data));
    const userRequest = userRequestMessageSchema.safeParse(message);
    if (userRequest.success) {
      const request = userRequest.data;
      void answerUser(ws, request.id, async () => {
        if (ws !== activeViewer()) throw new Error(INACTIVE_VIEWER);
        if (userHandler === undefined) throw new Error(NO_USER_HANDLER);
        return userHandler(request);
      });
      return;
    }
    const looseUser = looseUserRequestSchema.safeParse(message);
    if (looseUser.success) {
      void answerUser(ws, looseUser.data.id, () => Promise.reject(new Error(`서버가 읽을 수 없는 뷰어 요청입니다: ${userRequest.error.message}`)));
      return;
    }
    const parsed = responseMessageSchema.safeParse(message);
    if (parsed.success) tracker.settle(parsed.data);
    else log(`뷰어 메시지를 읽지 못했습니다: ${parsed.error.message}`);
  };

  // 연결 하나의 오류(잘못된 프레임, 연결 끊김 등)가 'error' 이벤트로 새어 나가면
  // 듣는 곳이 없어 MCP 서버 프로세스 전체가 죽는다. 로그를 남기고 그 연결만 정리한다.
  http.on('upgrade', (req, socket, head) => {
    socket.on('error', (error) => {
      log(`뷰어 연결 소켓 오류: ${error.message}`);
      socket.destroy();
    });
    if (tokenOf(req.url) !== token) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      viewers.push(ws);
      ws.on('message', (data) => {
        try {
          receive(ws, data);
        } catch (error) {
          log(`뷰어 메시지 처리 오류: ${String(error)}`);
        }
      });
      ws.on('close', () => removeViewer(ws));
      ws.on('error', (error) => {
        log(`뷰어 WebSocket 오류: ${error.message}`);
        removeViewer(ws);
        ws.terminate();
      });
      events.emit('connected');
    });
  });

  const { address: host, port } = await listenOnFreePort(http, options.port, options.portAttempts ?? PORT_ATTEMPTS);

  return {
    host,
    port,
    token,
    viewerUrl: `http://${HOST}:${port}/?token=${token}`,
    events,
    hasViewer: () => viewers.length > 0,
    serveUserRequests(handler) {
      userHandler = handler;
    },
    request(method, params) {
      const viewer = activeViewer();
      if (viewer === undefined) return Promise.reject(new ViewerNotConnectedError());
      const { id, promise } = tracker.start(method, parseViewerResult[method]);
      // 뷰어가 읽는 스키마로 먼저 확인한다. 맞지 않으면 보내지 않고 바로 실패(뷰어 타임아웃까지 기다리지 않게)
      const message = requestMessageSchema.safeParse({ type: 'request', id, method, params });
      if (!message.success) {
        tracker.settle({ type: 'response', id, ok: false, error: `뷰어에 보낼 수 없는 요청입니다(${method}): ${message.error.message}` });
        return promise;
      }
      const request: RequestMessage = message.data;
      viewer.send(JSON.stringify(request));
      return promise;
    },
    async close() {
      tracker.failAll(new ViewerNotConnectedError());
      for (const ws of viewers) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
