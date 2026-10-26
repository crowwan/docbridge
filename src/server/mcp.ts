// MCP 도구 등록. 도구는 문서 세션을 거쳐 뷰어와 이야기한다.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorMessage } from '../shared/errors.ts';
import { findText, getOutline, readBlockContents } from './read-tools.ts';
import { OUTLINE_LIMIT, READ_CHAR_LIMIT } from './reading.ts';
import type { DocumentSession } from './session.ts';

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

/** 도구 실행 오류를 Claude 가 읽을 수 있는 오류 결과로 바꾼다 */
async function toolResult(run: () => Promise<unknown>) {
  try {
    return text(JSON.stringify(await run()));
  } catch (error) {
    return { ...text(errorMessage(error)), isError: true };
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

  server.registerTool(
    'get_outline',
    {
      description: `열린 문서의 블록 목록(본문 문단·표·누름틀, 문서 순서). 블록마다 id, kind(paragraph·table·field), page(쪽), text(앞 40자), 자동 번호면 number, 개요 문단이면 outlineLevel, 누름틀이면 name. 한 번에 ${OUTLINE_LIMIT}블록까지이고 넘으면 more.next 의 from 으로 이어 받는다. 머리말·꼬리말·각주는 없다`,
      inputSchema: { from: z.string().optional().describe('이 블록 id 부터 돌려준다(이어 받기)') },
    },
    ({ from }) => toolResult(() => getOutline(session, from)),
  );

  server.registerTool(
    'read_blocks',
    {
      description: `블록 전문을 읽는다. ids 또는 쪽 범위(fromPage~toPage)로 고른다. 문단은 text, 표는 cells(칸마다 row·col(0부터)·text·rowLabel=같은 행 첫 칸), 누름틀은 name·guide·value. 한 번에 ${READ_CHAR_LIMIT.toLocaleString('en-US')}자까지이고 넘으면 more.next 를 인자로 다시 부른다`,
      inputSchema: {
        ids: z.array(z.string()).min(1).optional().describe('읽을 블록 id 목록(get_outline·find_text 의 id)'),
        fromPage: z.number().int().optional().describe('이 쪽부터(1부터)'),
        toPage: z.number().int().optional().describe('이 쪽까지(fromPage 이상, 문서 쪽 수 이하). 없으면 fromPage 한 쪽'),
        from: z.string().optional().describe('쪽 범위 안에서 이 블록 id 부터(이어 받기)'),
      },
    },
    (args) => toolResult(() => readBlockContents(session, args)),
  );

  server.registerTool(
    'find_text',
    {
      description:
        '문단·표 칸에서 글자를 찾는다(대소문자·띄어쓰기 그대로). 일치마다 { id, cell?: { row, col }, start, end, before, after } — 표 칸이면 cell(0부터), start·end 는 read_blocks 의 블록 text(표는 칸 text) 안 글자 위치(0부터, end 미포함), before·after 는 앞뒤 20자. id·cell·start·end 는 highlight 대상으로 그대로 넘긴다',
      inputSchema: { query: z.string().min(1).describe('찾을 글자') },
    },
    ({ query }) => toolResult(() => findText(session, query)),
  );

  return server;
}
