// MCP 도구 등록. 도구는 문서 세션을 거쳐 뷰어와 이야기한다.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { charLength } from '../core/chars.ts';
import { errorMessage } from '../shared/errors.ts';
import { NOTE_MAX_CHARS, textTargetSchema } from '../shared/protocol.ts';
import { UNDO_LIMIT } from '../core/edit-history.ts';
import { MAX_TABLE_SIZE } from '../core/create-document.ts';
import { deleteBlocks, insertParagraph, insertTable, moveBlocks, NOTHING_TO_UNDO, replaceText, undo } from './edit-tools.ts';
import { clearHighlight, highlight } from './highlight-tools.ts';
import { findText, getOutline, readBlockContents } from './read-tools.ts';
import { saveDocument } from './save-tool.ts';
import { OUTLINE_LIMIT, READ_CHAR_LIMIT } from './reading.ts';
import type { DocumentSession } from './session.ts';
import { listStyles, setStyle } from './style-tools.ts';

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
    'create_document',
    {
      description:
        '새 한글 문서를 만들어 뷰어에 띄운다(아직 파일은 없다 — save_document 로 저장). template 이 없으면 빈 A4 문서, 있으면 그 양식(.hwp/.hwpx, 읽기만 함)의 스타일·쪽 설정·머리말·꼬리말을 쓰고 본문(표·그림 포함)은 비운다(keep_content: true 면 본문도 남김). 열린 문서를 대신한다(저장하지 않은 편집은 버리고 warnings 로 알림). path 는 처음 저장할 자리로 절대 경로나 ~ 로 시작해야 하고(상대 경로 거부), 이미 있는 파일이면 거부한다. 확장자가 없으면 .hwpx. 결과 { path, pageCount, blockCount, firstBlock, styles: [{ name, englishName, outlineLevel? }], template?: { fileName, removedObjects, keptObjects } | { fileName, keptContent }, viewerUrl, warnings? } — firstBlock 은 첫 블록 id. 빈 문서·비운 양식이면 비어 있는 첫 문단이라 replace_text 로 채우고(보통 제목) 그 뒤로 insert_paragraph 한다(첫 문단 앞에는 넣을 수 없다). keep_content: true 면 양식 본문의 첫 블록이라 글자가 있거나 표·누름틀일 수 있으니 get_outline 으로 보고 쓴다. 채우기는 기존 편집 도구(replace_text·insert_paragraph·delete_blocks·move_blocks·undo)로 한다. 한 번도 저장하지 않은 새 문서는 뷰어를 새로고침하면 사라진다',
      inputSchema: {
        path: z.string().describe('처음 저장할 경로(절대 경로 또는 ~/…, 예: ~/Downloads/제안서.hwpx). 없는 파일이어야 한다'),
        template: z.string().optional().describe('양식으로 쓸 .hwp/.hwpx 파일 경로(절대 경로 또는 ~/…). 없으면 빈 문서'),
        keep_content: z.boolean().optional().describe('양식 본문을 남긴다(기본 false: 비움)'),
      },
    },
    ({ path, template, keep_content }) =>
      toolResult(() =>
        session.create({ path, ...(template === undefined ? {} : { template }), ...(keep_content === undefined ? {} : { keepContent: keep_content }) }),
      ),
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
        '기준 블록 앞(before) 또는 뒤(after)에 새 문단을 넣는다(바로 적용, undo 로 되돌림). before·after 중 하나만 준다. 기준이 표·누름틀이면 그것이 든 문단 앞뒤다. 문단 모양은 기준 문단, 글자 모양은 앞에 넣으면 기준 문단 첫 글자·뒤에 넣으면 마지막 글자를 따르고, 기준이 번호 문단이면 새 문단도 번호를 받아 번호가 다시 매겨진다. 구역 첫 문단 앞에는 넣지 못한다. text 는 줄바꿈 없이(문단 여럿은 문단마다 부른다), 비면 빈 문단. style(문단 스타일 이름, list_styles 의 name 이나 englishName)을 주면 새 문단은 그 스타일 모양 그대로다(문단·글자 모양 모두 스타일 것, 기준 문단 서식을 따르지 않는다. 개요 스타일이면 개요 번호를 받는다). 없는 스타일이면 넣지 않고 오류. 기존 블록 id 는 그대로다. 결과 { inserted(새 블록 id), changed: [{ id, number?, text }], warnings? } — changed 는 새 문단과 번호가 다시 매겨진 문단, number 는 넣은 뒤 자동 번호',
      inputSchema: {
        before: z.string().optional().describe('이 블록 앞에 넣는다'),
        after: z.string().optional().describe('이 블록 뒤에 넣는다'),
        text: z.string().describe('새 문단 글자(줄바꿈 없이)'),
        style: z.string().optional().describe('새 문단의 문단 스타일 이름(예: "개요 1" / "Outline 1", "본문"). list_styles 로 목록을 본다'),
      },
    },
    (args) => toolResult(() => insertParagraph(session, args)),
  );

  server.registerTool(
    'insert_table',
    {
      description: `기준 블록 앞(before) 또는 뒤(after)에 rows×cols 표를 새로 만든다(바로 적용, undo 한 번에 되돌림). before·after 중 하나만 주고, 기준이 표·누름틀이면 그것이 든 문단 앞뒤다(표 칸 안에는 만들지 않는다). 구역 첫 문단 앞에는 넣지 못한다. 표는 바탕글 문단에 들어가 앞 문단의 개요 번호·글자 서식을 물려받지 않고, 열 너비는 쪽 본문 너비를 열 수로 똑같이 나눈다. rows·cols 는 1~${MAX_TABLE_SIZE}. cells 는 행마다 열 수만큼의 글자 배열(rows×cols 와 크기가 같아야 한다)이고 칸 글자의 줄바꿈은 칸 안 문단이 된다. header: true 면 첫 행이 머리글(한글 제목 셀, 쪽을 넘기면 다시 나옴, 굵은 글자). 기존 블록 id 는 그대로다. 결과 { inserted(새 표 블록 id), cells(칸 수), changed: [{ id, number?, text }](새 표와 번호가 다시 매겨진 문단, number 는 넣은 뒤 자동 번호), warnings? } — 칸 글자를 고치려면 replace_text 에 { id, cell: { row, col } }`,
      inputSchema: {
        before: z.string().optional().describe('이 블록 앞에 넣는다'),
        after: z.string().optional().describe('이 블록 뒤에 넣는다'),
        rows: z.number().describe(`행 수(1~${MAX_TABLE_SIZE})`),
        cols: z.number().describe(`열 수(1~${MAX_TABLE_SIZE})`),
        cells: z.array(z.array(z.string())).optional().describe('칸 글자: [행][열]. 없으면 빈 칸'),
        header: z.boolean().optional().describe('첫 행을 머리글로(기본 false)'),
      },
    },
    (args) => toolResult(() => insertTable(session, args)),
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
    'move_blocks',
    {
      description:
        '열린 문서의 이어진 블록을 기준 블록 앞(before)이나 뒤(after)로 서식째(표·누름틀 포함) 옮긴다(바로 적용, undo 로 되돌림). 옮기는 단위는 본문 문단이라, 고른 블록과 같은 문단의 블록(문단 안 누름틀 등)과 사이 빈 문단도 같이 옮겨진다. 블록 id 는 그대로이고 자동 번호는 새 순서로 다시 매겨진다. 같은 구역 안에서만, 구역 첫 문단과 그 앞으로는 옮기지 않는다. 각주·책갈피 등이 든 문단은 옮기지 않고 이유와 id 를 돌려준다(그때는 insert_paragraph·delete_blocks). 결과 { moved(옮긴 id), changed: [{ id, number?, text }](옮긴 블록과 번호가 바뀐 문단, number 는 옮긴 뒤 자동 번호), warnings? } — warnings 의 "직접 입력한 번호" 는 글자로 친 번호라 바뀌지 않았다는 뜻이니 사용자에게 알리고 필요하면 replace_text 로 고친다',
      inputSchema: {
        ids: z.array(z.string()).min(1).describe('옮길 블록 id(get_outline 의 id). 문서에서 이어져 있어야 한다'),
        before: z.string().optional().describe('이 블록 앞으로 옮긴다(after 와 둘 중 하나)'),
        after: z.string().optional().describe('이 블록 뒤로 옮긴다(before 와 둘 중 하나)'),
      },
    },
    (args) => toolResult(() => moveBlocks(session, args)),
  );

  server.registerTool(
    'list_styles',
    {
      description:
        '열린 문서의 문단 스타일 목록(문서의 스타일 순서). 스타일마다 { name, englishName, outline, outlineLevel? } — outline 은 그 스타일 문단이 개요 번호를 받는지(이름이 아니라 스타일 모양으로 본다. 양식에 따라 "개요 1" 도 번호가 없을 수 있다), outlineLevel 은 개요 수준(1부터). 서식은 이 스타일로만 고른다(insert_paragraph 의 style, set_style). 글자 스타일은 없다',
      inputSchema: {},
    },
    () => toolResult(() => listStyles(session)),
  );

  server.registerTool(
    'set_style',
    {
      description:
        '문단 블록의 문단 스타일을 바꾼다(바로 적용, 여러 id 도 undo 한 번에 되돌림). style 은 list_styles 의 name 이나 englishName. 문단 모양은 스타일 것이 되고(정렬·들여쓰기 같은 직접 문단 모양은 없어진다 — 그래야 개요 번호가 붙는다), 글자는 스타일 글자 모양이던 글자만 바뀌고 직접 글자 서식(굵게 등)은 남는다. 표·누름틀 블록은 거부한다(그것이 든 문단은 그 문단 블록 id 로). 없는 스타일이면 바꾸지 않고 오류. 결과 { changed: [{ id, number?, text }], warnings? } — 고른 문단과 개요 번호가 바뀐 문단(뒤 개요 번호가 다시 매겨진 문단 포함), number 는 바꾼 뒤 자동 번호',
      inputSchema: {
        ids: z.array(z.string()).min(1).describe('스타일을 바꿀 문단 블록 id 목록'),
        style: z.string().describe('문단 스타일 이름(예: "개요 1" / "Outline 1", "본문", "제목")'),
      },
    },
    ({ ids, style }) => toolResult(() => setStyle(session, ids, style)),
  );

  server.registerTool(
    'undo',
    {
      description: `편집(replace_text·insert_paragraph·delete_blocks·move_blocks·set_style 등)을 최근 것부터 되돌린다. 최대 ${UNDO_LIMIT}단계이고 그보다 옛 편집은 되돌릴 수 없다. 뷰어가 다시 그려진다. 결과 { undone, edits(되돌린 편집, 최근 것부터), warnings? }. 되돌릴 것이 없으면 "${NOTHING_TO_UNDO}"`,
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
        '열린 문서를 HWPX 로 저장한다(원본이 .hwp 여도). path 가 없으면 원본 옆 <이름>-수정.hwpx(있으면 -수정-2 …). 상대 경로는 원본 폴더 기준, ~/ 는 홈, 확장자가 없으면 .hwpx 를 붙인다. 원본(.hwpx 일 때만)과 이미 있는 파일은 path 에 그 경로를 주고 overwrite: true 일 때만 덮어쓴다(원본을 덮어쓰려면 path 에 원본 경로 + overwrite: true. path 가 없으면 overwrite 는 무시하고 늘 새 이름). 저장 전에 내보낸 파일을 다시 열어 블록 글자를 비교하고, 다르면 파일을 쓰지 않고 달라진 블록 id 를 오류로 돌려준다. 결과 { path, bytes, verified: { blockCount }, warnings? } — warnings 는 내보내며 빠진 내용이라 사용자에게 알린다. 저장하면 이 파일이 마지막 파일(뷰어 새로고침 때 다시 읽는 파일)이 된다. create_document 로 만든 새 문서를 처음 저장할 때는 path 가 없으면 create_document 의 path 에 저장하고(이미 파일이 생겼으면 거부), 상대 경로는 그 폴더 기준이다. 처음 저장한 파일은 그 뒤로 원본처럼 쓴다',
      inputSchema: {
        path: z.string().optional().describe('저장할 경로(.hwpx). 없으면 원본 옆 <이름>-수정.hwpx(저장 전 새 문서는 create_document 의 path)'),
        overwrite: z.boolean().optional().describe('path 의 파일(원본 .hwpx 나 이미 있는 파일)을 덮어쓴다(기본 false). path 가 없으면 무시'),
      },
    },
    (args) => toolResult(() => saveDocument(session, args)),
  );

  return server;
}
