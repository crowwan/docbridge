// 뷰어 페이지(HTTP)와 뷰어 연결(WebSocket)을 127.0.0.1 한 포트에서 같이 연다.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  RequestTracker,
  responseMessageSchema,
  viewerResultSchemas,
  type RequestMessage,
  type ViewerMethod,
  type ViewerParams,
  type ViewerResult,
} from '../shared/protocol.ts';
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

  const receive = (data: unknown) => {
    const parsed = responseMessageSchema.safeParse(JSON.parse(String(data)));
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
          receive(data);
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
    request(method, params) {
      const viewer = activeViewer();
      if (viewer === undefined) return Promise.reject(new ViewerNotConnectedError());
      const { id, promise } = tracker.start(method, (result) => viewerResultSchemas[method].parse(result));
      const message: RequestMessage = { type: 'request', id, method, params };
      viewer.send(JSON.stringify(message));
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
