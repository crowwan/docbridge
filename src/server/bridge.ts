// 뷰어 페이지(HTTP)와 뷰어 연결(WebSocket)을 127.0.0.1 한 포트에서 같이 연다.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServerMessage } from '../shared/protocol.ts';
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
  viewerCount(): number;
  broadcast(message: ServerMessage): void;
  close(): Promise<void>;
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
  const viewers = new Set<WebSocket>();

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
      viewers.add(ws);
      ws.on('close', () => viewers.delete(ws));
      ws.on('error', (error) => {
        log(`뷰어 WebSocket 오류: ${error.message}`);
        viewers.delete(ws);
        ws.terminate();
      });
    });
  });

  const { address: host, port } = await listenOnFreePort(http, options.port, options.portAttempts ?? PORT_ATTEMPTS);

  return {
    host,
    port,
    token,
    viewerUrl: `http://${HOST}:${port}/?token=${token}`,
    viewerCount: () => viewers.size,
    broadcast(message) {
      const data = JSON.stringify(message);
      for (const ws of viewers) ws.send(data);
    },
    async close() {
      for (const ws of viewers) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
