// MCP 도구 등록. 도구는 문서 세션을 거쳐 뷰어와 이야기한다.
// 여러 문서(SPEC-007): 문서 도구는 doc(선택, 없으면 마지막으로 쓴 문서)으로 대상 문서 세션을 고르고 결과 맨 위에 doc 을 붙인다.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { charLength } from '../core/chars.ts';
import { errorMessage } from '../shared/errors.ts';
import { NOTE_MAX_CHARS, textTargetSchema } from '../shared/protocol.ts';
import { UNDO_LIMIT } from '../core/edit-history.ts';
import { MAX_TABLE_SIZE } from '../core/create-document.ts';
import { MAX_REPLACE_TARGETS } from '../core/edit-operations.ts';
import { deleteBlocks, insertParagraph, insertTable, moveBlocks, NOTHING_TO_UNDO, replaceAll, replaceText, targetsOf, undo } from './edit-tools.ts';
import { copyBlocks } from './copy-tool.ts';
import { clearHighlight, highlight } from './highlight-tools.ts';
import { findText, getOutline, readBlockContents } from './read-tools.ts';
import { saveDocument } from './save-tool.ts';
import { OUTLINE_LIMIT, READ_CHAR_LIMIT } from './reading.ts';
import { MAX_DOCUMENTS, type DocumentSessions } from './documents.ts';
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

/** 문서 도구 공용 입력: 대상 문서 이름 */
const docInput = {
  doc: z
    .string()
    .optional()
    .describe('대상 문서 이름(open_document·create_document·list_documents 의 doc, 예: d2). 없으면 마지막으로 쓴(열었거나 도구 대상이 된) 문서'),
};

export function createMcpServer(sessions: DocumentSessions): McpServer {
  const server = new McpServer({ name: 'docbridge', version: '0.0.0' });

  /**
   * run 을 돌려 도구 결과로 만들고 뒤에 알림(새로고침으로 사라진 편집, 탭 닫힘 등)을 글 한 덩이씩 붙인다. 성공·오류 모두.
   * run 이 대상 문서를 정하면(setTarget) 다른 문서의 알림 앞에 그 문서 이름을 붙인다
   */
  const toolResult = async (run: (setTarget: (doc: string) => void) => Promise<unknown>) => {
    let target: string | undefined;
    const result = await runTool(() =>
      run((doc) => {
        target = doc;
      }),
    );
    const notices = sessions.takeNotices(target).map((notice) => ({ type: 'text' as const, text: notice }));
    return notices.length === 0 ? result : { ...result, content: [...result.content, ...notices] };
  };

  /** 문서 도구: doc(없으면 마지막으로 쓴 문서)의 세션으로 run 하고 결과 맨 위에 doc 을 붙인다 */
  const documentTool = (doc: string | undefined, run: (session: DocumentSession) => Promise<object>) =>
    toolResult(async (setTarget) => {
      const session = sessions.get(doc);
      setTarget(session.name);
      return { doc: session.name, ...(await run(session)) };
    });

  /** 문서를 여는 도구(open·create): 결과의 doc 이 대상 문서 */
  const openingTool = (run: () => Promise<{ doc: string }>) =>
    toolResult(async (setTarget) => {
      const result = await run();
      setTarget(result.doc);
      return result;
    });

  server.registerTool(
    'open_document',
    {
      description:
        `로컬 한글 문서(.hwp, .hwpx)를 브라우저 뷰어의 새 탭에 띄운다(열린 문서를 대신하지 않는다 — 문서마다 탭 하나, ${MAX_DOCUMENTS}개까지). 문서 이름 doc(d1, d2 …)을 매겨 돌려주고, 다른 도구는 doc 으로 대상 문서를 고른다(없으면 마지막으로 쓴 문서). 이미 열린 파일을 다시 열면 새 탭을 만들지 않고 그 문서(같은 doc)에 파일을 다시 읽어 띄운다 — 그 문서의 저장하지 않은 편집은 버리고 warnings 로 알리며 블록 id 를 새로 매긴다. 결과 { doc, fileName, pageCount, blockCount, viewerUrl(그 문서 탭 주소), warnings? }. ${MAX_DOCUMENTS}개가 열려 있으면 거부한다(close_document 로 닫는다)`,
      inputSchema: { path: z.string().describe('열 문서의 로컬 경로 (~/ 로 시작해도 된다)') },
    },
    ({ path }) => openingTool(() => sessions.open(path)),
  );

  server.registerTool(
    'create_document',
    {
      description:
        `새 한글 문서를 만들어 뷰어에 띄운다(아직 파일은 없다 — save_document 로 저장). template 이 없으면 빈 A4 문서, 있으면 그 양식(.hwp/.hwpx, 읽기만 함)의 스타일·쪽 설정·머리말·꼬리말을 쓰고 본문(표·그림 포함)은 비운다(keep_content: true 면 본문도 남김). 열린 문서를 대신하지 않고 새 탭에 만들고 문서 이름 doc 을 매긴다(open_document 와 같은 ${MAX_DOCUMENTS}개 상한). path 는 처음 저장할 자리로 절대 경로나 ~ 로 시작해야 하고(상대 경로 거부), 이미 있는 파일이면 거부한다. 확장자가 없으면 .hwpx. 결과 { doc, path, pageCount, blockCount, firstBlock, styles: [{ name, englishName, outlineLevel? }], template?: { fileName, removedObjects, keptObjects } | { fileName, keptContent }, viewerUrl } — firstBlock 은 첫 블록 id. 빈 문서·비운 양식이면 비어 있는 첫 문단이라 replace_text 로 채우고(보통 제목) 그 뒤로 insert_paragraph 한다(첫 문단 앞에는 넣을 수 없다). keep_content: true 면 양식 본문의 첫 블록이라 글자가 있거나 표·누름틀일 수 있으니 get_outline 으로 보고 쓴다. 채우기는 기존 편집 도구(replace_text·insert_paragraph·delete_blocks·move_blocks·undo)로 한다. 한 번도 저장하지 않은 새 문서는 뷰어를 새로고침하면 사라진다`,
      inputSchema: {
        path: z.string().describe('처음 저장할 경로(절대 경로 또는 ~/…, 예: ~/Downloads/제안서.hwpx). 없는 파일이어야 한다'),
        template: z.string().optional().describe('양식으로 쓸 .hwp/.hwpx 파일 경로(절대 경로 또는 ~/…). 없으면 빈 문서'),
        keep_content: z.boolean().optional().describe('양식 본문을 남긴다(기본 false: 비움)'),
      },
    },
    ({ path, template, keep_content }) =>
      openingTool(() =>
        sessions.create({ path, ...(template === undefined ? {} : { template }), ...(keep_content === undefined ? {} : { keepContent: keep_content }) }),
      ),
  );

  server.registerTool(
    'get_outline',
    {
      description: `열린 문서의 블록 목록(본문 문단·표·누름틀, 문서 순서). 블록마다 id, kind(paragraph·table·field), page(쪽), text(앞 40자), 자동 번호면 number, 개요 문단이면 outlineLevel, 누름틀이면 name. 한 번에 ${OUTLINE_LIMIT}블록까지이고 넘으면 more.next 의 from 으로 이어 받는다. 머리말·꼬리말·각주는 없다`,
      inputSchema: { ...docInput, from: z.string().optional().describe('이 블록 id 부터 돌려준다(이어 받기)') },
    },
    ({ doc, from }) => documentTool(doc, (session) => getOutline(session, from)),
  );

  server.registerTool(
    'read_blocks',
    {
      description: `블록 전문을 읽는다. ids 또는 쪽 범위(fromPage~toPage)로 고른다. 문단은 text, 표는 cells(칸마다 row·col(0부터)·text·rowLabel=같은 행 첫 칸), 누름틀은 name·guide·value. 한 번에 ${READ_CHAR_LIMIT.toLocaleString('en-US')}자까지이고 넘으면 more.next 를 인자로 다시 부른다`,
      inputSchema: {
        ...docInput,
        ids: z.array(z.string()).min(1).optional().describe('읽을 블록 id 목록(get_outline·find_text 의 id)'),
        fromPage: z.number().int().optional().describe('이 쪽부터(1부터)'),
        toPage: z.number().int().optional().describe('이 쪽까지(fromPage 이상, 문서 쪽 수 이하). 없으면 fromPage 한 쪽'),
        from: z.string().optional().describe('쪽 범위 안에서 이 블록 id 부터(이어 받기)'),
      },
    },
    ({ doc, ...args }) => documentTool(doc, (session) => readBlockContents(session, args)),
  );

  server.registerTool(
    'find_text',
    {
      description:
        '문단·표 칸에서 글자를 찾는다(대소문자·띄어쓰기 그대로). 일치마다 { id, cell?: { row, col }, start, end, before, after } — 표 칸이면 cell(0부터), start·end 는 read_blocks 의 블록 text(표는 칸 text) 안 유니코드 글자 위치(0부터, end 미포함. 이모지도 한 글자), before·after 는 앞뒤 20자. id·cell·start·end 는 highlight 대상으로 그대로 넘긴다',
      inputSchema: { ...docInput, query: z.string().min(1).describe('찾을 글자') },
    },
    ({ doc, query }) => documentTool(doc, (session) => findText(session, query)),
  );

  server.registerTool(
    'highlight',
    {
      description:
        '답의 근거를 뷰어에 하이라이트하고 첫 대상이 보이게 스크롤한다. 이전 하이라이트는 지운다. 대상마다 { id, cell?: { row, col }, start?, end? } — find_text 일치(before·after 뺀 것)를 그대로 넘기면 된다. start·end 가 없으면 블록 전체(표는 cell 이 없으면 표 전체, 누름틀은 값, 값이 비면 안내문). 첫 대상은 준 순서의 첫 대상이다. 결과 { highlighted, pages, warnings? } — highlighted 는 그린 대상 수, pages 는 하이라이트가 있는 모든 쪽(1부터, 중복 없이 오름차순, 쪽을 넘는 문단·표는 걸친 쪽 모두), warnings 는 그리긴 했지만 정확하지 않을 수 있는 대상 안내(예: 빈 누름틀의 안내문 자리를 못 찾아 누름틀 자리에 작은 표시로 대신함). warnings 가 있으면 사용자에게 그 위치가 대략적이라고 알린다',
      inputSchema: {
        ...docInput,
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
    ({ doc, targets, note }) => documentTool(doc, (session) => highlight(session, targets, note)),
  );

  server.registerTool(
    'clear_highlight',
    { description: '뷰어의 하이라이트와 note 를 모두 지운다', inputSchema: { ...docInput } },
    ({ doc }) => documentTool(doc, (session) => clearHighlight(session)),
  );

  server.registerTool(
    'replace_text',
    {
      description:
        `열린 문서의 글자를 바꾼다(바로 적용, undo 로 되돌림). 같은 글자를 여러 곳에서 모두 바꿀 때는 replace_all 이 찾기와 바꾸기를 한 번에 한다(이 도구는 자리를 직접 고를 때). 자리 하나는 target, 여럿은 targets(${MAX_REPLACE_TARGETS} 곳까지)로 주고 둘 중 하나만 준다. targets 는 모두 같은 text 로 한 편집(undo 한 번)에 바뀌고, 위치는 모두 편집 전 문서 기준이다(find_text 결과를 그대로 넘기면 된다. 같은 블록 앞 자리 길이가 바뀌어도 docbridge 가 맞춘다). 같은 블록·칸에서 자리가 겹치거나(같은 위치에 넣기 둘 포함), 문단·칸 범위가 그 안 누름틀 값에 걸치거나(값은 누름틀 블록 id 로 바꾼다), 하나라도 틀리면 아무것도 바꾸지 않는다. 자리(target·targets 항목)는 find_text 일치나 { id, cell?: { row, col }, start?, end? } — start·end 가 없으면 블록 글자 전체(표는 cell 로 칸을 골라야 하고 칸 글자 전체, 누름틀은 값 전체이고 start·end 는 값 안 위치). 위치는 read_blocks 의 text(표는 칸 text) 안 유니코드 글자 위치(0부터, end 미포함). text 가 비면 범위를 지우고, start = end 면 그 자리에 넣는다. 줄바꿈이 든 text 는 받지 않는다. 바뀐 글자는 바뀌는 자리 첫 글자의 글자 모양을 따른다. 칸 범위가 칸 안 여러 문단에 걸치면 그 문단들이 합쳐진다. 뷰어는 다시 그려지고 바뀐 블록에 모두 초록 테두리가 남는다. 결과 { changed: [{ id, cell?, text }], warnings? } — changed 는 대상과 같은 문단에 걸린 블록 모두(누름틀 값을 바꾸면 그 문단도 바뀐다. 다음 편집은 read_blocks·find_text 로 새 위치를 얻어서), 표 칸은 바꾼 칸마다 하나, text 는 바뀐 뒤 블록(칸) 앞 40자, warnings 는 뷰어에 표시하지 못한 블록. "편집 기록이 어긋났습니다" 오류가 나면 open_document 로 문서를 다시 연다`,
      inputSchema: {
        ...docInput,
        target: textTargetSchema.optional().describe('바꿀 자리 하나. 블록 하나(또는 칸 하나) 안이어야 한다. targets 와 함께 주지 않는다'),
        targets: z
          .array(textTargetSchema)
          .min(1)
          .optional()
          .describe(`바꿀 자리 여럿(${MAX_REPLACE_TARGETS} 곳까지, 한 편집). 위치는 모두 편집 전 문서 기준. target 과 함께 주지 않는다`),
        text: z.string().describe('새 글자(모든 자리에 같은 글자. 빈 글자면 지우기, 줄바꿈 없이)'),
      },
    },
    ({ doc, target, targets, text }) => documentTool(doc, (session) => replaceText(session, targetsOf({ target, targets }), text)),
  );

  server.registerTool(
    'replace_all',
    {
      description: `같은 글자를 여러 곳 바꿀 때 쓴다("24년을 26년으로 다 바꿔줘"). 열린 문서의 본문 문단·표 칸에서 find 를 모두 찾아 text 로 바꾼다(바로 적용, 모두 한 편집이라 undo 한 번에 되돌림). 찾기 규칙은 find_text 와 같다(대소문자·띄어쓰기 그대로, 앞에서부터 겹치지 않게). 찾기는 바꾸기 전 문서에서 한 번만 하므로 text 에 find 가 들어 있어도("24" → "2024") 한 번씩만 바뀐다. ids 를 주면 그 블록 안 일치만 바꾼다("이 문단들의 A 만"). 누름틀 값·머리말·꼬리말·각주는 바꾸지 않는다(누름틀 값은 replace_text 에 누름틀 블록 id). 일치가 없으면 바꾸지 않고 오류("'<find>' 를 찾지 못했습니다."), ${MAX_REPLACE_TARGETS} 곳을 넘으면 바꾸지 않고 오류(ids 로 범위를 나눠 다시 부른다). 자리마다 바뀌는 자리 첫 글자의 글자 모양을 따른다. 뷰어는 다시 그려지고 바뀐 블록에 모두 초록 테두리가 남는다. 결과 { replaced, changed: [{ id, cell?, text }], warnings? } — replaced 는 바꾼 자리 수, changed 는 바뀐 블록(replace_text 결과와 같은 모양: 표는 바꾼 칸마다, text 는 바뀐 뒤 앞 40자). 몇 곳만 골라 바꾸려면 find_text 로 찾아 replace_text 의 targets 로 준다`,
      inputSchema: {
        ...docInput,
        find: z.string().min(1).describe('찾을 글자(find_text 의 query 와 같은 규칙)'),
        text: z.string().describe('바꿀 글자(빈 글자면 지우기, 줄바꿈 없이)'),
        ids: z.array(z.string()).min(1).optional().describe('이 블록들 안에서만 바꾼다(get_outline·find_text 의 id)'),
      },
    },
    ({ doc, find, text, ids }) => documentTool(doc, (session) => replaceAll(session, { find, text, ids })),
  );

  server.registerTool(
    'insert_paragraph',
    {
      description:
        '기준 블록 앞(before) 또는 뒤(after)에 새 문단을 넣는다(바로 적용, undo 로 되돌림). before·after 중 하나만 준다. 기준이 표·누름틀이면 그것이 든 문단 앞뒤다. 문단 모양은 기준 문단, 글자 모양은 앞에 넣으면 기준 문단 첫 글자·뒤에 넣으면 마지막 글자를 따르고, 기준이 번호 문단이면 새 문단도 번호를 받아 번호가 다시 매겨진다. 구역 첫 문단 앞에는 넣지 못한다. text 는 줄바꿈 없이(문단 여럿은 문단마다 부른다), 비면 빈 문단. style(문단 스타일 이름, list_styles 의 name 이나 englishName)을 주면 새 문단은 그 스타일 모양 그대로다(문단·글자 모양 모두 스타일 것, 기준 문단 서식을 따르지 않는다. 개요 스타일이면 개요 번호를 받는다). 없는 스타일이면 넣지 않고 오류. 기존 블록 id 는 그대로다. 결과 { inserted(새 블록 id), changed: [{ id, number?, text }], warnings? } — changed 는 새 문단과 번호가 다시 매겨진 문단, number 는 넣은 뒤 자동 번호',
      inputSchema: {
        ...docInput,
        before: z.string().optional().describe('이 블록 앞에 넣는다'),
        after: z.string().optional().describe('이 블록 뒤에 넣는다'),
        text: z.string().describe('새 문단 글자(줄바꿈 없이)'),
        style: z.string().optional().describe('새 문단의 문단 스타일 이름(예: "개요 1" / "Outline 1", "본문"). list_styles 로 목록을 본다'),
      },
    },
    ({ doc, ...args }) => documentTool(doc, (session) => insertParagraph(session, args)),
  );

  server.registerTool(
    'insert_table',
    {
      description: `기준 블록 앞(before) 또는 뒤(after)에 rows×cols 표를 새로 만든다(바로 적용, undo 한 번에 되돌림). before·after 중 하나만 주고, 기준이 표·누름틀이면 그것이 든 문단 앞뒤다(표 칸 안에는 만들지 않는다). 구역 첫 문단 앞에는 넣지 못한다. 표는 바탕글 문단에 들어가 앞 문단의 개요 번호·글자 서식을 물려받지 않고, 열 너비는 쪽 본문 너비를 열 수로 똑같이 나눈다. rows·cols 는 1~${MAX_TABLE_SIZE}. cells 는 행마다 열 수만큼의 글자 배열(rows×cols 와 크기가 같아야 한다)이고 칸 글자의 줄바꿈은 칸 안 문단이 된다. header: true 면 첫 행이 머리글(한글 제목 셀, 쪽을 넘기면 다시 나옴, 굵은 글자). 기존 블록 id 는 그대로다. 결과 { inserted(새 표 블록 id), cells(칸 수), changed: [{ id, number?, text }](새 표와 번호가 다시 매겨진 문단, number 는 넣은 뒤 자동 번호), warnings? } — 칸 글자를 고치려면 replace_text 에 { id, cell: { row, col } }`,
      inputSchema: {
        ...docInput,
        before: z.string().optional().describe('이 블록 앞에 넣는다'),
        after: z.string().optional().describe('이 블록 뒤에 넣는다'),
        rows: z.number().describe(`행 수(1~${MAX_TABLE_SIZE})`),
        cols: z.number().describe(`열 수(1~${MAX_TABLE_SIZE})`),
        cells: z.array(z.array(z.string())).optional().describe('칸 글자: [행][열]. 없으면 빈 칸'),
        header: z.boolean().optional().describe('첫 행을 머리글로(기본 false)'),
      },
    },
    ({ doc, ...args }) => documentTool(doc, (session) => insertTable(session, args)),
  );

  server.registerTool(
    'delete_blocks',
    {
      description:
        '블록(문단·표)을 지운다(바로 적용, 여러 id 도 undo 한 번에 되돌림). 문단 블록은 문단째 지워 그 문단에 든 표·누름틀도 같이 지워진다. 표 블록은 그 문단에 다른 블록이 없으면 문단째, 있으면 표만 지운다. 누름틀 블록은 지울 수 없고(값 비우기는 replace_text), 구역 첫 문단도 지울 수 없다(글자 지우기는 replace_text). 블록이 아닌 개체(머리말·각주·그림·수식 등)가 든 문단과, 누름틀이 든 문단에서 표만 지우기도 거부하고 이유를 돌려준다. 나머지 블록 id 는 그대로다. 결과 { deleted(지운 id, 같이 지워진 표·누름틀 포함) }',
      inputSchema: { ...docInput, ids: z.array(z.string()).min(1).describe('지울 블록 id 목록') },
    },
    ({ doc, ids }) => documentTool(doc, (session) => deleteBlocks(session, ids)),
  );

  server.registerTool(
    'move_blocks',
    {
      description:
        '열린 문서의 이어진 블록을 기준 블록 앞(before)이나 뒤(after)로 서식째(표·누름틀 포함) 옮긴다(바로 적용, undo 로 되돌림). 옮기는 단위는 본문 문단이라, 고른 블록과 같은 문단의 블록(문단 안 누름틀 등)과 사이 빈 문단도 같이 옮겨진다. 블록 id 는 그대로이고 자동 번호는 새 순서로 다시 매겨진다. 같은 구역 안에서만, 구역 첫 문단과 그 앞으로는 옮기지 않는다. 각주·책갈피 등이 든 문단은 옮기지 않고 이유와 id 를 돌려준다(그때는 insert_paragraph·delete_blocks). 결과 { moved(옮긴 id), changed: [{ id, number?, text }](옮긴 블록과 번호가 바뀐 문단, number 는 옮긴 뒤 자동 번호), warnings? } — warnings 의 "직접 입력한 번호" 는 글자로 친 번호라 바뀌지 않았다는 뜻이니 사용자에게 알리고 필요하면 replace_text 로 고친다',
      inputSchema: {
        ...docInput,
        ids: z.array(z.string()).min(1).describe('옮길 블록 id(get_outline 의 id). 문서에서 이어져 있어야 한다'),
        before: z.string().optional().describe('이 블록 앞으로 옮긴다(after 와 둘 중 하나)'),
        after: z.string().optional().describe('이 블록 뒤로 옮긴다(before 와 둘 중 하나)'),
      },
    },
    ({ doc, ...args }) => documentTool(doc, (session) => moveBlocks(session, args)),
  );

  server.registerTool(
    'copy_blocks',
    {
      description:
        '원본 문서(from)의 이어진 블록(문단·표)을 대상 문서(to)의 기준 블록 앞(before)이나 뒤(after)에 서식째 복사한다(바로 적용, 대상 문서의 편집 하나라 undo(doc: to) 한 번에 되돌림. 원본은 그대로). from·to 는 list_documents 의 doc 이고 같으면 같은 문서 안 사본. 원본 범위 규칙은 move_blocks 와 같다(이어진 블록, 같은 문단의 누름틀·사이 빈 문단도 같이). 대상 기준은 insert_paragraph 와 같다(구역 첫 문단 앞 거부, 표·누름틀이면 그것이 든 문단 앞뒤). 글자·문단 모양·표·그림·누름틀·도형은 원본 그대로 가져온다. 스타일: 대상에 같은 이름이 있으면 대상 스타일(스타일 모양이던 글자는 대상 모양, 직접 서식은 원본), 없으면 원본 스타일을 이름·모양 그대로 대상에 더한다(같은 이름 스타일이 둘 남지 않는다). 자동 번호는 대상 위치를 따라 다시 매겨진다(같은 모양 번호 목록이 있으면 잇고 없으면 1부터, 개요는 대상 개요 번호). 각주·미주·머리말·꼬리말·감추기·책갈피·하이퍼링크 등이 든 문단이 범위에 있으면 아무것도 넣지 않고 문단마다 이유와 원본 id 를 돌려준다(그때는 read_blocks + insert_paragraph). 표 칸 하나의 글자만 옮기려면 read_blocks + replace_text. 결과 { doc(대상), inserted(넣은 블록의 새 id — 문단 글자·표·누름틀마다), changed: [{ id, number?, text }](넣은 블록과 번호가 다시 매겨진 문단), warnings? }',
      inputSchema: {
        from: z.string().describe('원본 문서 이름(예: d1)'),
        ids: z.array(z.string()).min(1).describe('복사할 원본 블록 id(원본 get_outline 의 id). 문서에서 이어져 있어야 한다'),
        to: z.string().describe('대상 문서 이름(예: d2). from 과 같으면 같은 문서 안 사본'),
        before: z.string().optional().describe('대상 문서의 이 블록 앞에 넣는다(after 와 둘 중 하나)'),
        after: z.string().optional().describe('대상 문서의 이 블록 뒤에 넣는다(before 와 둘 중 하나)'),
      },
    },
    ({ from, to, ...args }) =>
      toolResult(async (setTarget) => {
        const source = sessions.get(from);
        // 대상이 마지막으로 쓴 문서가 된다(원본을 먼저 고른다)
        const target = sessions.get(to);
        setTarget(target.name);
        return { doc: target.name, ...(await copyBlocks(source, target, args)) };
      }),
  );

  server.registerTool(
    'list_styles',
    {
      description:
        '열린 문서의 문단 스타일 목록(문서의 스타일 순서). 스타일마다 { name, englishName, outline, outlineLevel? } — outline 은 그 스타일 문단이 개요 번호를 받는지(이름이 아니라 스타일 모양으로 본다. 양식에 따라 "개요 1" 도 번호가 없을 수 있다), outlineLevel 은 개요 수준(1부터). 서식은 이 스타일로만 고른다(insert_paragraph 의 style, set_style). 글자 스타일은 없다',
      inputSchema: { ...docInput },
    },
    ({ doc }) => documentTool(doc, (session) => listStyles(session)),
  );

  server.registerTool(
    'set_style',
    {
      description:
        '문단 블록의 문단 스타일을 바꾼다(바로 적용, 여러 id 도 undo 한 번에 되돌림). style 은 list_styles 의 name 이나 englishName. 문단 모양은 스타일 것이 되고(정렬·들여쓰기 같은 직접 문단 모양은 없어진다 — 그래야 개요 번호가 붙는다), 글자는 스타일 글자 모양이던 글자만 바뀌고 직접 글자 서식(굵게 등)은 남는다. 표·누름틀 블록은 거부한다(그것이 든 문단은 그 문단 블록 id 로). 없는 스타일이면 바꾸지 않고 오류. 결과 { changed: [{ id, number?, text }], warnings? } — 고른 문단과 개요 번호가 바뀐 문단(뒤 개요 번호가 다시 매겨진 문단 포함), number 는 바꾼 뒤 자동 번호',
      inputSchema: {
        ...docInput,
        ids: z.array(z.string()).min(1).describe('스타일을 바꿀 문단 블록 id 목록'),
        style: z.string().describe('문단 스타일 이름(예: "개요 1" / "Outline 1", "본문", "제목")'),
      },
    },
    ({ doc, ids, style }) => documentTool(doc, (session) => setStyle(session, ids, style)),
  );

  server.registerTool(
    'undo',
    {
      description: `편집(replace_text·insert_paragraph·delete_blocks·move_blocks·set_style·copy_blocks(대상 문서) 등)을 최근 것부터 되돌린다. 최대 ${UNDO_LIMIT}단계이고 그보다 옛 편집은 되돌릴 수 없다. 뷰어가 다시 그려진다. 사용자가 뷰어에서 고친 편집도 같은 줄에 쌓여 같이 되돌린다(edits 에 "(사용자 화면 편집)" 이 붙는다). 결과 { undone, edits(되돌린 편집, 최근 것부터), warnings? }. 되돌릴 것이 없으면 "${NOTHING_TO_UNDO}"`,
      inputSchema: {
        ...docInput,
        steps: z.number().int().min(1).max(UNDO_LIMIT).default(1).describe(`되돌릴 편집 수(기본 1, 최대 ${UNDO_LIMIT})`),
      },
    },
    ({ doc, steps }) => documentTool(doc, (session) => undo(session, steps)),
  );

  server.registerTool(
    'save_document',
    {
      description:
        '열린 문서를 HWPX 로 저장한다(원본이 .hwp 여도). path 가 없으면 원본 옆 <이름>-수정.hwpx(있으면 -수정-2 …). 상대 경로는 원본 폴더 기준, ~/ 는 홈, 확장자가 없으면 .hwpx 를 붙인다. 원본(.hwpx 일 때만)과 이미 있는 파일은 path 에 그 경로를 주고 overwrite: true 일 때만 덮어쓴다(원본을 덮어쓰려면 path 에 원본 경로 + overwrite: true. path 가 없으면 overwrite 는 무시하고 늘 새 이름). 저장 전에 내보낸 파일을 다시 열어 블록 글자를 비교하고, 다르면 파일을 쓰지 않고 달라진 블록 id 를 오류로 돌려준다. 결과 { path, bytes, verified: { blockCount }, warnings? } — warnings 는 내보내며 빠진 내용이라 사용자에게 알린다. 저장하면 이 파일이 마지막 파일(뷰어 새로고침 때 다시 읽는 파일)이 된다. create_document 로 만든 새 문서를 처음 저장할 때는 path 가 없으면 create_document 의 path 에 저장하고(이미 파일이 생겼으면 거부), 상대 경로는 그 폴더 기준이다. 처음 저장한 파일은 그 뒤로 원본처럼 쓴다',
      inputSchema: {
        ...docInput,
        path: z.string().optional().describe('저장할 경로(.hwpx). 없으면 원본 옆 <이름>-수정.hwpx(저장 전 새 문서는 create_document 의 path)'),
        overwrite: z.boolean().optional().describe('path 의 파일(원본 .hwpx 나 이미 있는 파일)을 덮어쓴다(기본 false). path 가 없으면 무시'),
      },
    },
    ({ doc, ...args }) => documentTool(doc, (session) => saveDocument(session, args)),
  );

  server.registerTool(
    'list_documents',
    {
      description:
        '열린 문서 목록(연 순서). 문서마다 { doc, fileName, path, newDocument?, pageCount, unsavedEdits, current } — path 는 마지막 파일(저장 전 새 문서는 처음 저장할 자리이고 newDocument: true), unsavedEdits 는 저장하지 않은 편집 수, current 는 doc 을 안 줬을 때 도구의 대상(마지막으로 쓴 문서)',
      inputSchema: {},
    },
    () => toolResult(async () => sessions.list()),
  );

  server.registerTool(
    'close_document',
    {
      description:
        '문서를 닫는다(뷰어 탭의 문서를 닫고 열린 문서에서 뺀다. 그 탭은 다음에 여는 문서가 쓴다). 저장하지 않은 편집이 있거나 한 번도 저장하지 않은 새 문서면 닫지 않고 "저장하지 않은 편집 n개가 있습니다. 저장하거나 discard: true 로 닫아 주세요." — discard: true 면 버리고 닫고 warnings 로 버린 것을 알린다. 결과 { doc, closed: true, warnings? }',
      inputSchema: {
        ...docInput,
        discard: z.boolean().optional().describe('저장하지 않은 편집(또는 저장 전 새 문서)을 버리고 닫는다(기본 false)'),
      },
    },
    ({ doc, discard }) =>
      toolResult(async (setTarget) => {
        const result = await sessions.close(doc, discard ?? false);
        setTarget(result.doc);
        return result;
      }),
  );

  return server;
}
