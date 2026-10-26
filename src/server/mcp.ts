// MCP 도구 등록. 도구는 문서 세션을 거쳐 뷰어와 이야기한다.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DocumentSession } from './session.ts';

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

/** 도구 실행 오류를 Claude 가 읽을 수 있는 오류 결과로 바꾼다 */
async function toolResult(run: () => Promise<unknown>) {
  try {
    return text(JSON.stringify(await run()));
  } catch (error) {
    return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
  }
}

export function createMcpServer(session: DocumentSession): McpServer {
  const server = new McpServer({ name: 'docbridge', version: '0.0.0' });

  server.registerTool(
    'open_document',
    {
      description:
        '로컬 한글 문서(.hwp, .hwpx)를 브라우저 뷰어에 띄운다. 뷰어가 없으면 기본 브라우저로 열고, 있으면 그 탭의 문서를 바꾼다. 파일 이름·쪽 수·블록 수·뷰어 주소를 돌려준다',
      inputSchema: { path: z.string().describe('열 문서의 로컬 경로 (~/ 로 시작해도 된다)') },
    },
    ({ path }) => toolResult(() => session.open(path)),
  );

  return server;
}
