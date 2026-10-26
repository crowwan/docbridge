import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { PORT_ATTEMPTS, startBridge, type Bridge } from '../src/server/bridge.ts';
import { FakeViewer, paragraphBlocks } from './fake-viewer.ts';
import { fixturePath } from './fixtures.ts';

const serverEntry = fileURLToPath(new URL('../src/server/index.ts', import.meta.url));
const openResultSchema = z.object({ fileName: z.string(), pageCount: z.number(), viewerUrl: z.string() });
const toolResultSchema = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })) });

/** 서버가 stderr 에 남기는 "뷰어 주소: …" 줄에서 주소를 읽는다 */
function viewerUrlFromLog(stderr: Readable): Promise<string> {
  return new Promise((resolve) => {
    let output = '';
    const onData = (chunk: Buffer) => {
      output += String(chunk);
      const url = /뷰어 주소: (\S+)/.exec(output)?.[1];
      if (url === undefined) return;
      stderr.off('data', onData);
      resolve(url);
    };
    stderr.on('data', onData);
  });
}

function connectViewer(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url.replace('http://', 'ws://'));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

// ws 라이브러리를 거치지 않고 손으로 WebSocket 핸드셰이크를 한 뒤 잘못된 프레임을 보낸다.
// 연결이 닫히면(서버가 그 연결만 정리하면) 풀린다.
function sendMalformedFrame(port: number, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(
        [
          `GET /?token=${token} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.once('data', (response) => {
      if (!String(response).startsWith('HTTP/1.1 101')) {
        reject(new Error(`핸드셰이크 실패: ${String(response)}`));
        return;
      }
      // FIN + 예약된 opcode 0x3, 마스크 켬, 길이 0, 마스크 키 4바이트
      socket.write(Buffer.from([0x83, 0x80, 1, 2, 3, 4]));
    });
    socket.once('close', () => resolve());
  });
}

/** 127.0.0.1 의 빈 포트 하나를 잡아 둔다(다른 프로그램이 쓰는 포트 흉내) */
function occupyPort(port = 0): Promise<Server> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('포트가 없습니다');
  return address.port;
}

describe('SPEC-001 MCP·뷰어 서버', () => {
  let client: Client | undefined;
  let bridge: Bridge | undefined;

  afterEach(async () => {
    await client?.close();
    await bridge?.close();
    client = undefined;
    bridge = undefined;
  });

  it('stdio 로 띄운 MCP 서버의 open_document 가 같은 프로세스의 WebSocket 에 붙은 뷰어에 문서를 보낸다', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: { ...getDefaultEnvironment(), DOCBRIDGE_PORT: '0' },
      stderr: 'pipe',
    });
    const stderr = transport.stderr;
    if (!(stderr instanceof PassThrough)) throw new Error('stderr 를 읽을 수 없습니다');
    const viewerUrl = viewerUrlFromLog(stderr);
    client = new Client({ name: 'docbridge-test', version: '0.0.0' });
    await client.connect(transport);

    const viewer = await FakeViewer.connect(await viewerUrl);
    const opening = client.callTool({ name: 'open_document', arguments: { path: fixturePath('notice.hwpx') } });
    const request = await viewer.nextRequest();
    viewer.respond(request.id, { pageCount: 1, blocks: paragraphBlocks(14) });
    const result = toolResultSchema.parse(await opening);

    expect(request.params.fileName).toBe('notice.hwpx');
    expect(openResultSchema.parse(JSON.parse(result.content[0]?.text ?? ''))).toEqual({
      fileName: 'notice.hwpx',
      pageCount: 1,
      viewerUrl: await viewerUrl,
    });
    expect(await viewerUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=.+/);
    viewer.close();
  });

  it('세션 토큰이 없거나 틀린 WebSocket 연결은 거부한다', async () => {
    bridge = await startBridge({ port: 0, viewerDir: tmpdir() });
    const base = `http://127.0.0.1:${bridge.port}/`;
    await expect(connectViewer(base)).rejects.toThrow(/401/);
    await expect(connectViewer(`${base}?token=wrong`)).rejects.toThrow(/401/);
    expect(bridge.viewerCount()).toBe(0);
  });

  it('한 연결이 잘못된 프레임을 보내도 서버는 살아 있고 다른 뷰어는 계속 요청을 받는다', async () => {
    bridge = await startBridge({ port: 0, viewerDir: tmpdir() });
    const healthy = await FakeViewer.connect(bridge.viewerUrl);

    await sendMalformedFrame(bridge.port, bridge.token);
    const answered = bridge.request('load_document', { fileName: 'a.hwpx', data: '' });
    const request = await healthy.nextRequest();
    healthy.respond(request.id, { pageCount: 1, blocks: [] });

    expect(await answered).toEqual({ pageCount: 1, blocks: [] });
    expect(bridge.viewerCount()).toBe(1);
    healthy.close();
  });

  it('뷰어 페이지와 WASM 파일을 127.0.0.1 에서 알맞은 형식으로 내준다', async () => {
    const viewerDir = await mkdtemp(join(tmpdir(), 'docbridge-viewer-'));
    await writeFile(join(viewerDir, 'index.html'), '<!doctype html><title>뷰어</title>');
    await writeFile(join(viewerDir, 'rhwp_bg.wasm'), new Uint8Array([0, 97, 115, 109]));
    bridge = await startBridge({ port: 0, viewerDir });

    const page = await fetch(bridge.viewerUrl);
    const wasm = await fetch(`http://127.0.0.1:${bridge.port}/rhwp_bg.wasm`);

    expect(page.status).toBe(200);
    expect(await page.text()).toContain('뷰어');
    expect(wasm.headers.get('content-type')).toBe('application/wasm');
  });

  it('이름에 한글·공백이 든 정적 파일도 인코딩된 주소로 내준다', async () => {
    const viewerDir = await mkdtemp(join(tmpdir(), 'docbridge-viewer-'));
    await writeFile(join(viewerDir, '한글 파일.js'), 'export {}');
    bridge = await startBridge({ port: 0, viewerDir });

    const response = await fetch(`http://127.0.0.1:${bridge.port}/${encodeURIComponent('한글 파일.js')}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('export {}');
  });

  it('서버는 127.0.0.1 에서만 열린다', async () => {
    bridge = await startBridge({ port: 0, viewerDir: tmpdir() });
    expect(bridge.host).toBe('127.0.0.1');
  });

  it('기본 포트가 사용 중이면 다음 빈 포트로 열고 뷰어 주소에 그 포트를 쓴다', async () => {
    const busy = await occupyPort();
    const taken = portOf(busy);
    try {
      bridge = await startBridge({ port: taken, viewerDir: tmpdir() });
      expect(bridge.port).toBeGreaterThan(taken);
      expect(bridge.port).toBeLessThan(taken + PORT_ATTEMPTS);
      expect(bridge.viewerUrl).toContain(`:${bridge.port}/`);
    } finally {
      busy.close();
    }
  });

  it('시도할 포트가 모두 사용 중이면 시작하지 못하고 이유를 알린다', async () => {
    const busy = await occupyPort();
    try {
      await expect(startBridge({ port: portOf(busy), viewerDir: tmpdir(), portAttempts: 1 })).rejects.toThrow(
        `포트 ${portOf(busy)}~${portOf(busy)} 이 모두 사용 중입니다`,
      );
    } finally {
      busy.close();
    }
  });
});
