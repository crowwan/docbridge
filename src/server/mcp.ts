// MCP 도구 등록. 도구는 문서 세션을 거쳐 뷰어와 이야기한다.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { charLength } from '../core/chars.ts';
import { errorMessage } from '../shared/errors.ts';
import { NOTE_MAX_CHARS, textTargetSchema } from '../shared/protocol.ts';
import { UNDO_LIMIT } from '../core/edit-history.ts';
import { deleteBlocks, insertParagraph, NOTHING_TO_UNDO, replaceText, undo } from './edit-tools.ts';
import { clearHighlight, highlight } from './highlight-tools.ts';
import { findText, getOutline, readBlockContents } from './read-tools.ts';
import { saveDocument } from './save-tool.ts';
import { OUTLINE_LIMIT, READ_CHAR_LIMIT } from './reading.ts';
import type { DocumentSession } from './session.ts';

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

/** 도구 실행 오류를 Claude 가 읽을 수 있는 오류 결과로 바꾼다 */
async function runTool(run: () => Promise<unknown>) {
  try {
    return text(JSON.stringify(await run()));
  } catch (error) {
    return { ...text(errorMessage(error)), isError: true };
  }
}

export function createMcpServer(session: DocumentSession): McpServer {
  const server = new McpServer({ name: 'docbridge', version: '0.0.0' });

  /** 도구 결과 뒤에 세션 알림(새로고침으로 사라진 편집 등)을 글 한 덩이씩 붙인다. 성공·오류 모두 */
  const toolResult = async (run: () => Promise<unknown>) => {
    const result = await runTool(run);
    const notices = session.takeNotices().map((notice) => ({ type: 'text' as const, text: notice }));
    return notices.length === 0 ? result : { ...result, content: [...result.content, ...notices] };
  };

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
        '문단·표 칸에서 글자를 찾는다(대소문자·띄어쓰기 그대로). 일치마다 { id, cell?: { row, col }, start, end, before, after } — 표 칸이면 cell(0부터), start·end 는 read_blocks 의 블록 text(표는 칸 text) 안 유니코드 글자 위치(0부터, end 미포함. 이모지도 한 글자), before·after 는 앞뒤 20자. id·cell·start·end 는 highlight 대상으로 그대로 넘긴다',
      inputSchema: { query: z.string().min(1).describe('찾을 글자') },
    },
    ({ query }) => toolResult(() => findText(session, query)),
  );

  server.registerTool(
    'highlight',
    {
      description:
        '답의 근거를 뷰어에 하이라이트하고 첫 대상이 보이게 스크롤한다. 이전 하이라이트는 지운다. 대상마다 { id, cell?: { row, col }, start?, end? } — find_text 일치(before·after 뺀 것)를 그대로 넘기면 된다. start·end 가 없으면 블록 전체(표는 cell 이 없으면 표 전체, 누름틀은 값, 값이 비면 안내문). 첫 대상은 준 순서의 첫 대상이다. 결과 { highlighted, pages, warnings? } — highlighted 는 그린 대상 수, pages 는 하이라이트가 있는 모든 쪽(1부터, 중복 없이 오름차순, 쪽을 넘는 문단·표는 걸친 쪽 모두), warnings 는 그리긴 했지만 정확하지 않을 수 있는 대상 안내(예: 빈 누름틀의 안내문 자리를 못 찾아 누름틀 자리에 작은 표시로 대신함). warnings 가 있으면 사용자에게 그 위치가 대략적이라고 알린다',
      inputSchema: {
        targets: z.array(textTargetSchema).min(1).describe('하이라이트할 대상. 첫 대상으로 스크롤한다'),
        note: z
          .string()
          .refine((note) => charLength(note.trim()) <= NOTE_MAX_CHARS, {
            message: `note 는 앞뒤 공백을 빼고 ${NOTE_MAX_CHARS}자(유니코드 글자)까지입니다.`,
          })
          .optional()
          .describe(`하이라이트 옆에 짧게 보일 말(${NOTE_MAX_CHARS}자까지)`),
      },
    },
    ({ targets, note }) => toolResult(() => highlight(session, targets, note)),
  );

  server.registerTool(
    'clear_highlight',
    { description: '뷰어의 하이라이트와 note 를 모두 지운다', inputSchema: {} },
    () => toolResult(() => clearHighlight(session)),
  );

  server.registerTool(
    'replace_text',
    {
      description:
        '열린 문서의 글자를 바꾼다(바로 적용, undo 로 되돌림). target 은 find_text 일치나 { id, cell?: { row, col }, start?, end? } — start·end 가 없으면 블록 글자 전체(표는 cell 로 칸을 골라야 하고 칸 글자 전체, 누름틀은 값 전체이고 start·end 는 값 안 위치). 위치는 read_blocks 의 text(표는 칸 text) 안 유니코드 글자 위치(0부터, end 미포함). text 가 비면 범위를 지우고, start = end 면 그 자리에 넣는다. 줄바꿈이 든 text 는 받지 않는다. 바뀐 글자는 바뀌는 자리 첫 글자의 글자 모양을 따른다. 칸 범위가 칸 안 여러 문단에 걸치면 그 문단들이 합쳐진다. 뷰어는 다시 그려지고 바뀐 블록에 초록 테두리가 남는다. 결과 { changed: [{ id, cell?, text }], warnings? } — changed 는 대상과 같은 문단에 걸린 블록 모두(누름틀 값을 바꾸면 그 문단도 바뀐다. 다음 편집은 read_blocks·find_text 로 새 위치를 얻어서), text 는 바뀐 뒤 블록(칸) 앞 40자, warnings 는 뷰어에 표시하지 못한 블록. "편집 기록이 어긋났습니다" 오류가 나면 open_document 로 문서를 다시 연다',
      inputSchema: {
        target: textTargetSchema.describe('바꿀 자리. 블록 하나(또는 칸 하나) 안이어야 한다'),
        text: z.string().describe('새 글자(빈 글자면 지우기, 줄바꿈 없이)'),
      },
    },
    ({ target, text }) => toolResult(() => replaceText(session, target, text)),
  );

  server.registerTool(
    'insert_paragraph',
    {
      description:
        '기준 블록 앞(before) 또는 뒤(after)에 새 문단을 넣는다(바로 적용, undo 로 되돌림). before·after 중 하나만 준다. 기준이 표·누름틀이면 그것이 든 문단 앞뒤다. 문단 모양은 기준 문단, 글자 모양은 앞에 넣으면 기준 문단 첫 글자·뒤에 넣으면 마지막 글자를 따르고, 기준이 번호 문단이면 새 문단도 번호를 받아 번호가 다시 매겨진다. 구역 첫 문단 앞에는 넣지 못한다. text 는 줄바꿈 없이(문단 여럿은 문단마다 부른다), 비면 빈 문단. 기존 블록 id 는 그대로다. 결과 { inserted(새 블록 id), changed: [{ id, text }], warnings? }',
      inputSchema: {
        before: z.string().optional().describe('이 블록 앞에 넣는다'),
        after: z.string().optional().describe('이 블록 뒤에 넣는다'),
        text: z.string().describe('새 문단 글자(줄바꿈 없이)'),
      },
    },
    (args) => toolResult(() => insertParagraph(session, args)),
  );

  server.registerTool(
    'delete_blocks',
    {
      description:
        '블록(문단·표)을 지운다(바로 적용, 여러 id 도 undo 한 번에 되돌림). 문단 블록은 문단째 지워 그 문단에 든 표·누름틀도 같이 지워진다. 표 블록은 그 문단에 다른 블록이 없으면 문단째, 있으면 표만 지운다. 누름틀 블록은 지울 수 없고(값 비우기는 replace_text), 구역 첫 문단도 지울 수 없다(글자 지우기는 replace_text). 블록이 아닌 개체(머리말·각주·그림·수식 등)가 든 문단과, 누름틀이 든 문단에서 표만 지우기도 거부하고 이유를 돌려준다. 나머지 블록 id 는 그대로다. 결과 { deleted(지운 id, 같이 지워진 표·누름틀 포함) }',
      inputSchema: { ids: z.array(z.string()).min(1).describe('지울 블록 id 목록') },
    },
    ({ ids }) => toolResult(() => deleteBlocks(session, ids)),
  );

  server.registerTool(
    'undo',
    {
      description: `편집(replace_text·insert_paragraph·delete_blocks 등)을 최근 것부터 되돌린다. 최대 ${UNDO_LIMIT}단계이고 그보다 옛 편집은 되돌릴 수 없다. 뷰어가 다시 그려진다. 결과 { undone, edits(되돌린 편집, 최근 것부터), warnings? }. 되돌릴 것이 없으면 "${NOTHING_TO_UNDO}"`,
      inputSchema: {
        steps: z.number().int().min(1).max(UNDO_LIMIT).default(1).describe(`되돌릴 편집 수(기본 1, 최대 ${UNDO_LIMIT})`),
      },
    },
    ({ steps }) => toolResult(() => undo(session, steps)),
  );

  server.registerTool(
    'save_document',
    {
      description:
        '열린 문서를 HWPX 로 저장한다(원본이 .hwp 여도). path 가 없으면 원본 옆 <이름>-수정.hwpx(있으면 -수정-2 …). 상대 경로는 원본 폴더 기준, ~/ 는 홈, 확장자가 없으면 .hwpx 를 붙인다. 원본(.hwpx 일 때만)과 이미 있는 파일은 path 에 그 경로를 주고 overwrite: true 일 때만 덮어쓴다(원본을 덮어쓰려면 path 에 원본 경로 + overwrite: true. path 가 없으면 overwrite 는 무시하고 늘 새 이름). 저장 전에 내보낸 파일을 다시 열어 블록 글자를 비교하고, 다르면 파일을 쓰지 않고 달라진 블록 id 를 오류로 돌려준다. 결과 { path, bytes, verified: { blockCount }, warnings? } — warnings 는 내보내며 빠진 내용이라 사용자에게 알린다. 저장하면 이 파일이 마지막 파일(뷰어 새로고침 때 다시 읽는 파일)이 된다',
      inputSchema: {
        path: z.string().optional().describe('저장할 경로(.hwpx). 없으면 원본 옆 <이름>-수정.hwpx'),
        overwrite: z.boolean().optional().describe('path 의 파일(원본 .hwpx 나 이미 있는 파일)을 덮어쓴다(기본 false). path 가 없으면 무시'),
      },
    },
    (args) => toolResult(() => saveDocument(session, args)),
  );

  return server;
}
