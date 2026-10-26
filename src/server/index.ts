// docbridge 실행 진입점: MCP(stdio) 서버와 뷰어용 HTTP·WebSocket 서버를 한 프로세스에서 띄운다.
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startBridge } from './bridge.ts';
import { log } from './log.ts';
import { createMcpServer } from './mcp.ts';

const DEFAULT_PORT = 7790;

const port = Number(process.env['DOCBRIDGE_PORT'] ?? DEFAULT_PORT);
// 빌드 결과 기준 dist/server/index.js → dist/viewer
const viewerDir = fileURLToPath(new URL('../viewer/', import.meta.url));

const bridge = await startBridge({ port, viewerDir });
log(`뷰어 주소: ${bridge.viewerUrl}`);

const server = createMcpServer(bridge);
await server.connect(new StdioServerTransport());

process.stdin.on('close', () => {
  void bridge.close().then(() => process.exit(0));
});
