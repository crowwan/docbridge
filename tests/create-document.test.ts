// SPEC-003 새 문서 만들기(#36): create_document(빈 문서·양식)와 새 문서 저장·새로고침, 새 문서에서의 SPEC-002 편집.
// MCP 클라이언트 → 서버 → rhwp 테스트 뷰어(뷰어와 같은 core 함수로 새 문서를 만든다). 파일은 mkdtemp 임시 폴더에만 쓴다.
import { once } from 'node:events';
import { copyFile, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HwpDocument } from '@rhwp/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractBlocks } from '../src/core/blocks.ts';
import { paragraphStyles, TITLE_STYLE } from '../src/core/styles.ts';
import { exportVerifiedHwpx } from '../src/core/hwpx-export.ts';
import { parseJson } from '../src/core/json.ts';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { createMcpServer } from '../src/server/mcp.ts';
import {
  newDocumentExistsMessage,
  newDocumentTakenMessage,
  RELATIVE_NEW_PATH,
  RELATIVE_TEMPLATE_PATH,
  resolveNewDocumentPath,
  writeSave,
} from '../src/server/save-path.ts';
import { saveDocument } from '../src/server/save-tool.ts';
import { DocumentSessions } from '../src/server/documents.ts';
import { discardedNewDocumentMessage, NO_DOCUMENT, newDocumentLostMessage } from '../src/server/session.ts';
import { FakeViewer } from './fake-viewer.ts';
import { fixturePath, openFixture } from './fixtures.ts';
import { withoutDoc } from './tool-result.ts';
import { rhwpViewer, type RhwpViewer } from './rhwp-viewer.ts';

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});
const styleSchema = z.object({ name: z.string(), englishName: z.string(), outlineLevel: z.number().optional() });
const createResultSchema = z.object({
  path: z.string(),
  pageCount: z.number(),
  blockCount: z.number(),
  firstBlock: z.string(),
  styles: z.array(styleSchema),
  template: z
    .union([
      z.object({ fileName: z.string(), removedObjects: z.record(z.string(), z.number()), keptObjects: z.record(z.string(), z.number()) }),
      z.object({ fileName: z.string(), keptContent: z.literal(true) }),
    ])
    .optional(),
  viewerUrl: z.string(),
  warnings: z.array(z.string()).optional(),
});
const saveResultSchema = z.object({ path: z.string(), verified: z.object({ blockCount: z.number() }) });
const outlineSchema = z.object({ blocks: z.array(z.object({ id: z.string(), kind: z.string(), text: z.string() })) });
const headerFooterSchema = z.looseObject({ exists: z.boolean(), text: z.string().optional() });

let bridge: Bridge;
let sessions: DocumentSessions;
let client: Client;
let dir: string;
const sockets: FakeViewer[] = [];

const call = async (name: string, args: Record<string, unknown> = {}) =>
  toolResultSchema.parse(await client.callTool({ name, arguments: args }));
/** 도구 하나를 부르고 결과 JSON 을 돌려준다(오류면 던진다) */
const json = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  const result = await call(name, args);
  if (result.isError) throw new Error(result.content[0]?.text);
  return withoutDoc(JSON.parse(result.content[0]?.text ?? ''));
};
const toolError = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await call(name, args);
  expect(result.isError).toBe(true);
  return result.content[0]?.text;
};
const create = async (args: Record<string, unknown>) => createResultSchema.parse(await json('create_document', args));
const save = async (args: Record<string, unknown> = {}) => saveResultSchema.parse(await json('save_document', args));
const outline = async () => {
  const result = await call('get_outline');
  if (result.isError) throw new Error(result.content[0]?.text);
  return outlineSchema.parse(JSON.parse(result.content[0]?.text ?? '')).blocks;
};
const outlineTexts = async () => (await outline()).map((block) => block.text);

/** rhwp 테스트 뷰어를 붙인다. doc 을 주면 그 문서 탭 주소로(새로고침한 탭), 없으면 빈 탭 */
const connectRhwp = async (doc?: string): Promise<RhwpViewer> => {
  const socket = await FakeViewer.connect(doc === undefined ? bridge.viewerUrl : bridge.viewerUrlFor(doc));
  sockets.push(socket);
  const viewer = rhwpViewer();
  socket.serve(viewer.handle);
  return viewer;
};

/** 뷰어 탭 새로고침: 연결이 끊기고 같은 주소(문서 이름 포함)로 새 (빈) 뷰어가 붙는다 */
const refresh = async (): Promise<RhwpViewer> => {
  const doc = sessions.current?.name;
  const disconnected = once(bridge.events, 'disconnected');
  sockets.at(-1)?.close();
  await disconnected;
  const viewer = await connectRhwp(doc);
  await sessions.ready();
  return viewer;
};

const fileTexts = async (path: string) => {
  const doc = new HwpDocument(new Uint8Array(await readFile(path)));
  try {
    return extractBlocks(doc).map((block) => (block.kind === 'paragraph' ? block.text : block.kind));
  } finally {
    doc.free();
  }
};

/** report.hwpx 에 머리말·꼬리말을 더한 양식 파일(HWPX)을 임시 폴더에 만든다 */
const makeTemplate = async (name: string): Promise<string> => {
  const doc = openFixture('report.hwpx');
  try {
    doc.createHeaderFooter(0, true, 0);
    doc.insertTextInHeaderFooter(0, true, 0, 0, 0, '가나다구청 보고서');
    doc.createHeaderFooter(0, false, 0);
    doc.insertTextInHeaderFooter(0, false, 0, 0, 0, '대외비');
    const path = join(dir, name);
    await writeFile(path, exportVerifiedHwpx(doc).bytes);
    return path;
  } finally {
    doc.free();
  }
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'docbridge-create-'));
  bridge = await startBridge({ port: 0, viewerDir: tmpdir() });
  sessions = new DocumentSessions(bridge, { openBrowser: () => {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(sessions).connect(serverSide);
  client = new Client({ name: 'docbridge-test', version: '0.0.0' });
  await client.connect(clientSide);
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await client.close();
  await bridge.close();
});

describe('SPEC-003 새 문서 만들기 (create_document)', () => {
  it('AC-1 빈 문서를 뷰어에 띄우고 저장 경로·쪽 수·블록 수·첫 블록 id·스타일 목록("제목" 포함)을 돌려준다. 파일은 아직 만들지 않는다', async () => {
    const viewer = await connectRhwp();
    const path = join(dir, '제안서.hwpx');

    const result = await create({ path });

    expect(result).toMatchObject({ path, pageCount: 1, blockCount: 1, firstBlock: 'b1', viewerUrl: bridge.viewerUrlFor('d1') });
    expect(result.warnings).toBeUndefined();
    expect(result.template).toBeUndefined();
    expect(result.styles).toContainEqual({ name: TITLE_STYLE.name, englishName: TITLE_STYLE.englishName });
    expect(result.styles).toContainEqual({ name: '개요 1', englishName: 'Outline 1', outlineLevel: 1 });
    expect(result.styles).toContainEqual({ name: '본문', englishName: 'Body' });
    // 첫 블록은 첫 구역 첫 문단(빈 문단)
    expect(await outline()).toEqual([{ id: 'b1', kind: 'paragraph', text: '' }]);
    expect(viewer.editor().blocks).toEqual([{ kind: 'paragraph', section: 0, paragraph: 0, page: 1, text: '' }]);
    expect(await readdir(dir)).toEqual([]);
    expect(sessions.document?.location).toEqual({ kind: 'new', savePath: path });
  });

  it('AC-1 확장자가 없으면 .hwpx 를 붙이고, ~ 는 홈 폴더다', async () => {
    await connectRhwp();
    expect((await create({ path: join(dir, '제안서') })).path).toBe(join(dir, '제안서.hwpx'));
    const home = await mkdtemp(join(tmpdir(), 'docbridge-home-'));
    expect(await resolveNewDocumentPath('~/초안.hwpx', home)).toBe(join(home, '초안.hwpx'));
  });

  it('AC-1 path 에 파일이 이미 있거나 상대 경로·다른 확장자·없는 폴더면 뷰어에 보내지 않고 거부한다', async () => {
    const socket = await FakeViewer.connect(bridge.viewerUrl);
    sockets.push(socket);
    const existing = join(dir, '있음.hwpx');
    await copyFile(fixturePath('notice.hwpx'), existing);

    expect(await toolError('create_document', { path: existing })).toBe(newDocumentExistsMessage(existing));
    expect(await toolError('create_document', { path: join(dir, '있음') })).toBe(newDocumentExistsMessage(existing));
    expect(await toolError('create_document', { path: '제안서.hwpx' })).toBe(RELATIVE_NEW_PATH);
    expect(await toolError('create_document', { path: './제안서.hwpx' })).toBe(RELATIVE_NEW_PATH);
    expect(await toolError('create_document', { path: join(dir, '제안서.docx') })).toBe(
      'HWPX 로만 저장합니다(.docx). 경로를 .hwpx 로 끝내거나 확장자를 빼세요.',
    );
    expect(await toolError('create_document', { path: join(dir, '없는 폴더', '제안서.hwpx') })).toBe(
      `저장할 폴더가 없습니다: ${join(dir, '없는 폴더')}`,
    );
    expect(await toolError('create_document', { path: dir })).toBe(`폴더입니다: ${dir}. 파일 경로를 주세요.`);
    expect(socket.history).toEqual([]);
    expect(await readFile(existing)).toEqual(await readFile(fixturePath('notice.hwpx')));
  });

  it('SPEC-007 저장하지 않은 편집이 있는 문서가 있어도 대신하지 않고 새 탭(새 doc)에 만든다 — 앞 문서의 편집은 그대로다', async () => {
    await connectRhwp();
    await connectRhwp();
    const source = join(dir, '공문.hwpx');
    await copyFile(fixturePath('notice.hwpx'), source);
    await json('open_document', { path: source });
    await json('replace_text', { target: { id: 'b1' }, text: '고친 제목' });
    await json('replace_text', { target: { id: 'b2' }, text: '고친 둘째' });

    const created = await call('create_document', { path: join(dir, '새 문서.hwpx') });

    expect(JSON.parse(created.content[0]?.text ?? '')).toMatchObject({ doc: 'd2', firstBlock: 'b1' });
    expect(JSON.parse(created.content[0]?.text ?? '')).not.toHaveProperty('warnings');
    expect(await outlineTexts()).toEqual(['']);
    expect(sessions.get('d1').unsavedEdits).toBe(2);
    expect(sessions.get('d1').document?.fileName).toBe('공문.hwpx');
  });

  it('SPEC-007 한 번도 저장하지 않은 새 문서는 편집이 없어도 close_document 가 discard 없이는 닫지 않고, discard 로 닫으면 새 문서를 버렸다고 알린다', async () => {
    await connectRhwp();
    const template = join(dir, '공문 양식.hwpx');
    await copyFile(fixturePath('notice.hwpx'), template);
    await create({ path: join(dir, '양식 그대로.hwpx'), template, keep_content: true });

    expect(await toolError('close_document')).toBe('저장하지 않은 새 문서 양식 그대로.hwpx 입니다(편집 0개). 저장하거나 discard: true 로 닫아 주세요.');
    expect(await json('close_document', { discard: true })).toEqual({
      closed: true,
      warnings: [discardedNewDocumentMessage('양식 그대로.hwpx', 0)],
    });
    expect(sessions.list().documents).toEqual([]);
  });

  it('AC-2 template 을 주면 양식의 스타일·쪽 설정·머리말·꼬리말을 쓰고 본문(표 포함)은 비우며, 지운 개체·남긴 개체를 알리고 양식 파일은 그대로다', async () => {
    const viewer = await connectRhwp();
    const template = await makeTemplate('보고서 양식.hwpx');
    const before = await readFile(template);
    const original = new HwpDocument(new Uint8Array(before));
    const templateStyles = paragraphStyles(original).map(({ name }) => name);
    const pageDef = original.getPageDef(0);
    original.free();

    const result = await create({ path: join(dir, '보고서.hwpx'), template });

    expect(result).toMatchObject({ pageCount: 1, blockCount: 1, firstBlock: 'b1' });
    expect(result.template).toEqual({
      fileName: '보고서 양식.hwpx',
      removedObjects: { 표: 1 },
      keptObjects: { '구역 정의': 1, '단 정의': 1, 머리말: 1, 꼬리말: 1 },
    });
    expect(await outlineTexts()).toEqual(['']);
    // 양식 스타일 그대로 + 제목(양식에 없어서 더함)
    expect(result.styles.map(({ name }) => name)).toEqual([...templateStyles, TITLE_STYLE.name]);
    const { doc } = viewer.editor();
    expect(doc.getPageDef(0)).toBe(pageDef);
    expect(parseJson(headerFooterSchema, doc.getHeaderFooter(0, true, 0))).toMatchObject({ exists: true, text: '가나다구청 보고서' });
    expect(parseJson(headerFooterSchema, doc.getHeaderFooter(0, false, 0))).toMatchObject({ exists: true, text: '대외비' });
    expect(await readFile(template)).toEqual(before);
    expect(await readdir(dir)).toEqual(['보고서 양식.hwpx']);
  });

  it('AC-2 keep_content: true 면 양식 본문이 남는다', async () => {
    const viewer = await connectRhwp();
    const template = join(dir, '공문 양식.hwp');
    await copyFile(fixturePath('notice.hwp'), template);

    const result = await create({ path: join(dir, '공문.hwpx'), template, keep_content: true });

    expect(result.template).toEqual({ fileName: '공문 양식.hwp', keptContent: true });
    const kept = viewer.editor().blocks.map((block) => (block.kind === 'paragraph' ? block.text : block.kind));
    expect(kept).toEqual(await fileTexts(template));
    expect(result.blockCount).toBe(kept.length);
  });

  it('양식 파일을 못 읽으면 SPEC-001 열기 오류 문구를 돌려준다(형식·없음·rhwp 이유)', async () => {
    await connectRhwp();
    const path = join(dir, '새 문서.hwpx');
    expect(await toolError('create_document', { path, template: join(dir, '없음.hwpx') })).toBe(`파일을 찾을 수 없습니다: ${join(dir, '없음.hwpx')}`);
    expect(await toolError('create_document', { path, template: join(dir, '양식.docx') })).toBe(
      '열 수 없는 파일 형식입니다(.docx). .hwp, .hwpx 만 열 수 있습니다.',
    );
    expect(await toolError('create_document', { path, template: '양식.hwpx' })).toBe(RELATIVE_TEMPLATE_PATH);
    const broken = join(dir, '깨진 양식.hwpx');
    await writeFile(broken, 'hwpx 가 아님');
    expect(await toolError('create_document', { path, template: broken })).toMatch(/^문서를 열 수 없습니다: /);
    expect(sessions.document).toBeUndefined();
  });
});

describe('SPEC-003 새 문서 저장 (save_document)', () => {
  it('AC-7 경로 없이 저장하면 create_document 의 path 에 저장되고, 다시 open_document 하면 내용이 그대로다', async () => {
    await connectRhwp();
    const path = join(dir, '제안서.hwpx');
    const { firstBlock } = await create({ path });
    await json('replace_text', { target: { id: firstBlock }, text: 'DocBridge 도입 제안서' });
    await json('insert_paragraph', { after: firstBlock, text: '제안 배경' });

    const result = await save();

    expect(result.path).toBe(path);
    expect(await readdir(dir)).toEqual(['제안서.hwpx']);
    expect(await fileTexts(path)).toEqual(['DocBridge 도입 제안서', '제안 배경']);
    expect(sessions.document?.location).toEqual({ kind: 'file', path, sourcePath: path });
    await json('open_document', { path });
    expect(await outlineTexts()).toEqual(['DocBridge 도입 제안서', '제안 배경']);
  });

  it('처음 저장한 파일은 원본처럼 쓴다: 다음 경로 없는 저장은 <이름>-수정.hwpx', async () => {
    await connectRhwp();
    const path = join(dir, '제안서.hwpx');
    const { firstBlock } = await create({ path });
    await json('replace_text', { target: { id: firstBlock }, text: '첫 저장' });
    await save();
    await json('replace_text', { target: { id: firstBlock }, text: '둘째 저장' });

    expect((await save()).path).toBe(join(dir, '제안서-수정.hwpx'));
    expect(await fileTexts(path)).toEqual(['첫 저장']);
  });

  it('경로 없이 저장할 때 그사이 그 자리에 파일이 생겼으면 덮지 않고 거부한다', async () => {
    await connectRhwp();
    const path = join(dir, '제안서.hwpx');
    await create({ path });
    await writeFile(path, '다른 프로그램이 만든 파일');

    expect(await toolError('save_document')).toBe(newDocumentTakenMessage(path));
    expect(await readFile(path, 'utf8')).toBe('다른 프로그램이 만든 파일');
    expect(sessions.document?.location.kind).toBe('new');
  });

  it('경로를 정한 뒤 쓰기 전에 그 자리에 파일이 생겨도 번호를 붙이거나 덮지 않고 거부한다', async () => {
    await connectRhwp();
    const path = join(dir, '제안서.hwpx');
    await create({ path });
    const raced: typeof writeSave = async (target, bytes) => {
      await writeFile(path, '그사이 생긴 파일');
      return writeSave(target, bytes);
    };

    await expect(saveDocument(sessions.get(), {}, raced)).rejects.toThrow(newDocumentTakenMessage(path));
    expect(await readFile(path, 'utf8')).toBe('그사이 생긴 파일');
    expect(await readdir(dir)).toEqual(['제안서.hwpx']);
  });

  it('새 문서의 상대 경로 저장은 create_document 의 path 폴더 기준이다', async () => {
    await connectRhwp();
    await create({ path: join(dir, '제안서.hwpx') });

    expect((await save({ path: '제안서 사본' })).path).toBe(join(dir, '제안서 사본.hwpx'));
  });
});

describe('SPEC-003 새 문서와 새로고침', () => {
  it('AC-8 한 번도 저장하지 않은 새 문서를 새로고침하면 사라졌다고 다음 도구 결과에 알리고 열린 문서를 비운다', async () => {
    await connectRhwp();
    const path = join(dir, '제안서.hwpx');
    const { firstBlock } = await create({ path });
    await json('replace_text', { target: { id: firstBlock }, text: '제목' });

    await refresh();

    const result = await call('get_outline');
    expect(result.isError).toBe(true);
    expect(result.content.map((c) => c.text)).toEqual([NO_DOCUMENT, newDocumentLostMessage(path, 1)]);
    expect(sessions.document).toBeUndefined();
    // 알림은 한 번만
    expect((await call('get_outline')).content.map((c) => c.text)).toEqual([NO_DOCUMENT]);
  });

  it('AC-8 뷰어는 저장 전 새 문서면 편집이 없어도 확인 창을 띄우고, 저장하면 띄우지 않는다', async () => {
    const viewer = await connectRhwp();
    await create({ path: join(dir, '제안서.hwpx') });
    expect(viewer.confirmsUnload()).toBe(true);

    await save();

    expect(viewer.confirmsUnload()).toBe(false);
    expect(viewer.editStates).toEqual([{ fileName: '제안서.hwpx', unsavedEdits: 0, newDocument: false, state: 0 }]);
  });

  it('저장한 새 문서는 새로고침하면 저장한 파일로 돌아간다(사라지지 않는다)', async () => {
    await connectRhwp();
    const path = join(dir, '제안서.hwpx');
    const { firstBlock } = await create({ path });
    await json('replace_text', { target: { id: firstBlock }, text: '저장한 제목' });
    await save();

    await refresh();

    const result = await call('get_outline');
    expect(result.content.slice(1)).toEqual([]);
    expect(await outlineTexts()).toEqual(['저장한 제목']);
  });
});

describe('SPEC-003 블록이 없는 문서의 첫 블록', () => {
  it('만든 직후 저장하면 저장 전 검증·저장 블록에 첫 빈 문단이 들고, 새로고침해도 파일이 바뀌었다고 보지 않아 id 표가 그대로다', async () => {
    await connectRhwp();
    const { firstBlock } = await create({ path: join(dir, '제안서.hwpx') });

    const saved = await save();

    expect(saved.verified).toEqual({ blockCount: 1 });
    expect(sessions.document?.blocks).toEqual([{ kind: 'paragraph', section: 0, paragraph: 0 }]);
    const ids = sessions.document?.ids;
    await refresh();
    // 블록 위치가 같으면 새로고침은 id 표를 그대로 둔다(다시 매기면 새 표가 된다)
    expect(sessions.document?.ids).toBe(ids);
    expect(await outline()).toEqual([{ id: firstBlock, kind: 'paragraph', text: '' }]);
  });

  it('비운 채 저장한 새 문서를 새로고침하거나 다시 열어도 첫 문단이 빈 문단 블록이라 채울 수 있다', async () => {
    await connectRhwp();
    const path = join(dir, '제안서.hwpx');
    const { firstBlock } = await create({ path });
    await save();

    await refresh();
    expect(await outline()).toEqual([{ id: firstBlock, kind: 'paragraph', text: '' }]);
    await json('replace_text', { target: { id: firstBlock }, text: '새로고침 뒤 제목' });
    expect(await outlineTexts()).toEqual(['새로고침 뒤 제목']);

    await json('open_document', { path });
    expect(await outline()).toEqual([{ id: 'b1', kind: 'paragraph', text: '' }]);
  });
});

describe('SPEC-003 새 문서에 표 넣기 (insert_table)', () => {
  const insertedSchema = z.object({ inserted: z.string() });
  const cellsSchema = z.object({ blocks: z.array(z.object({ id: z.string(), kind: z.string(), cells: z.array(z.object({ text: z.string() })).optional() })) });

  it('새 문서의 첫 블록 뒤에 표를 넣고 저장해 다시 열면 제목과 표·칸 글자가 그대로다', async () => {
    await connectRhwp();
    const path = join(dir, '제안서.hwpx');
    const { firstBlock } = await create({ path });
    await json('replace_text', { target: { id: firstBlock }, text: '도입 일정' });
    const table = insertedSchema.parse(
      await json('insert_table', { after: firstBlock, rows: 2, cols: 2, cells: [['단계', '시기'], ['시범', '11월']], header: true }),
    );
    expect(await outline()).toEqual([
      { id: firstBlock, kind: 'paragraph', text: '도입 일정' },
      { id: table.inserted, kind: 'table', text: expect.any(String) },
    ]);

    expect((await save()).verified).toEqual({ blockCount: 2 });
    await json('open_document', { path });

    expect((await outline()).map(({ kind }) => kind)).toEqual(['paragraph', 'table']);
    expect(await outlineTexts()).toContain('도입 일정');
    const read = cellsSchema.parse(await json('read_blocks', { ids: ['b2'] }));
    expect(read.blocks[0]?.cells?.map(({ text }) => text)).toEqual(['단계', '시기', '시범', '11월']);
  });

  it('첫 블록을 비운 채 표만 넣으면 표가 블록이라 첫 빈 문단은 저장한 파일에서 블록이 아니다(블록이 없을 때만 남기는 규칙). 다시 열어도 표 앞에 문단을 넣을 수 있다', async () => {
    await connectRhwp();
    const path = join(dir, '표만.hwpx');
    const { firstBlock } = await create({ path });
    await json('insert_table', { after: firstBlock, rows: 1, cols: 2, cells: [['가', '나']] });

    expect((await save()).verified).toEqual({ blockCount: 1 });
    await json('open_document', { path });
    expect((await outline()).map(({ kind }) => kind)).toEqual(['table']);

    await json('insert_paragraph', { before: 'b1', text: '표 제목' });
    expect((await outline()).map(({ kind, text }) => (kind === 'table' ? 'table' : text))).toEqual(['표 제목', 'table']);
  });
});

describe('SPEC-003 새 문서에서의 편집 (SPEC-002 도구)', () => {
  it('AC-9 새 문서에서 replace_text·insert_paragraph·move_blocks·delete_blocks·undo 가 SPEC-002 와 같이 동작한다', async () => {
    await connectRhwp();
    const { firstBlock } = await create({ path: join(dir, '제안서.hwpx') });

    await json('replace_text', { target: { id: firstBlock }, text: '제안서' });
    const first = z.object({ inserted: z.string() }).parse(await json('insert_paragraph', { after: firstBlock, text: '하나' }));
    const second = z.object({ inserted: z.string() }).parse(await json('insert_paragraph', { after: first.inserted, text: '둘' }));
    expect(await outlineTexts()).toEqual(['제안서', '하나', '둘']);

    await json('move_blocks', { ids: [second.inserted], before: first.inserted });
    expect(await outlineTexts()).toEqual(['제안서', '둘', '하나']);
    await json('delete_blocks', { ids: [first.inserted] });
    expect(await outlineTexts()).toEqual(['제안서', '둘']);
    expect(await toolError('insert_paragraph', { before: firstBlock, text: '첫 문단 앞' })).toMatch(/구역 첫 문단/);

    expect(z.object({ undone: z.number() }).parse(await json('undo', { steps: 2 })).undone).toBe(2);
    expect(await outlineTexts()).toEqual(['제안서', '하나', '둘']);
    expect(sessions.unsavedEdits).toBe(3);
    await json('undo', { steps: 3 });
    expect(await outline()).toEqual([{ id: firstBlock, kind: 'paragraph', text: '' }]);
    expect(sessions.unsavedEdits).toBe(0);
  });
});
