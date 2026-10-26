import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { startBridge, type Bridge } from '../src/server/bridge.ts';

const serverEntry = fileURLToPath(new URL('../src/server/index.ts', import.meta.url));
const pingResultSchema = z.object({ viewerUrl: z.string(), viewers: z.number() });
const toolResultSchema = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })) });

async function callPing(client: Client) {
  const result = toolResultSchema.parse(await client.callTool({ name: 'ping', arguments: {} }));
  return pingResultSchema.parse(JSON.parse(result.content[0]?.text ?? ''));
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

const nextMessage = (ws: WebSocket) =>
  new Promise<unknown>((resolve) => ws.once('message', (data) => resolve(JSON.parse(String(data)))));

describe('SPEC-001 MCP·뷰어 서버 동시 구동 (기술 검증)', () => {
  let client: Client | undefined;
  let bridge: Bridge | undefined;

  afterEach(async () => {
    await client?.close();
    await bridge?.close();
    client = undefined;
    bridge = undefined;
  });

  it('stdio 로 띄운 MCP 서버의 도구를 부르면 같은 프로세스의 WebSocket 에 붙은 뷰어가 메시지를 받는다', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: { ...getDefaultEnvironment(), DOCBRIDGE_PORT: '0' },
      stderr: 'pipe',
    });
    client = new Client({ name: 'docbridge-test', version: '0.0.0' });
    await client.connect(transport);

    const first = await callPing(client);
    expect(first.viewers).toBe(0);
    expect(first.viewerUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=.+/);

    const viewer = await connectViewer(first.viewerUrl);
    const received = nextMessage(viewer);
    const second = await callPing(client);

    expect(second.viewers).toBe(1);
    expect(await received).toMatchObject({ type: 'ping' });
    viewer.close();
  });

  it('세션 토큰이 없거나 틀린 WebSocket 연결은 거부한다', async () => {
    bridge = await startBridge({ port: 0, viewerDir: tmpdir() });
    const base = `http://127.0.0.1:${bridge.port}/`;
    await expect(connectViewer(base)).rejects.toThrow(/401/);
    await expect(connectViewer(`${base}?token=wrong`)).rejects.toThrow(/401/);
    expect(bridge.viewerCount()).toBe(0);
  });

  it('한 연결이 잘못된 프레임을 보내도 서버는 살아 있고 다른 뷰어는 계속 메시지를 받는다', async () => {
    bridge = await startBridge({ port: 0, viewerDir: tmpdir() });
    const healthy = await connectViewer(bridge.viewerUrl);

    await sendMalformedFrame(bridge.port, bridge.token);
    const received = nextMessage(healthy);
    bridge.broadcast({ type: 'ping', at: 1 });

    expect(await received).toEqual({ type: 'ping', at: 1 });
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
});
