// MCP 도구 등록. 기술 검증 단계에서는 연결 확인용 ping 도구 하나만 둔다.
// 실제 도구(open_document 등)는 #5~#7 에서 추가한다.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Bridge } from './bridge.ts';

export function createMcpServer(bridge: Bridge): McpServer {
  const server = new McpServer({ name: 'docbridge', version: '0.0.0' });

  server.registerTool(
    'ping',
    {
      description: '연결 확인: 열린 뷰어에 ping 을 보내고, 뷰어 주소와 연결된 뷰어 수를 돌려준다',
    },
    () => {
      bridge.broadcast({ type: 'ping', at: Date.now() });
      const result = { viewerUrl: bridge.viewerUrl, viewers: bridge.viewerCount() };
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  return server;
}
