import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { BlockAnchor } from '../src/core/block-ids.ts';
import { INACTIVE_VIEWER, startBridge, type Bridge } from '../src/server/bridge.ts';
import { DocumentSessions, MAX_DOCUMENTS, TOO_MANY_DOCUMENTS } from '../src/server/documents.ts';
import { NOTHING_TO_UNDO } from '../src/server/edit-tools.ts';
import { createMcpServer } from '../src/server/mcp.ts';
import type { RequestMessage, UserResponseMessage } from '../src/shared/protocol.ts';
import { FakeViewer, NO_RESPONSE, paragraphBlocks } from './fake-viewer.ts';
import { fixturePath } from './fixtures.ts';
import { rhwpViewer, type RhwpViewer } from './rhwp-viewer.ts';

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});
const outlineSchema = z.object({ doc: z.string(), blocks: z.array(z.object({ id: z.string(), text: z.string().optional() })) });

/** 테스트 브라우저의 탭 하나: 뷰어 연결과 그 뷰어가 연 rhwp 문서 */
interface Tab {
  socket: FakeViewer;
  rhwp: RhwpViewer;
}

describe('SPEC-007 여러 문서 세션·탭과 doc 인자 (list_documents · close_document)', () => {
  let bridge: Bridge;
  let sessions: DocumentSessions;
  let client: Client;
  let dir: string;
  /** 문서 탭 주소로 연 탭(문서 이름 → 탭). openBrowser 가 새 탭을 띄우듯 붙인다 */
  let tabs: Map<string, Tab>;
  const sockets: FakeViewer[] = [];
  let openBrowser: ReturnType<typeof vi.fn<(url: string) => void>>;

  const call = async (name: string, args: Record<string, unknown> = {}) =>
    toolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const json = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const result = await call(name, args);
    if (result.isError) throw new Error(result.content[0]?.text);
    return JSON.parse(result.content[0]?.text ?? '');
  };
  const errorText = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    return result.content[0]?.text ?? '';
  };
  const notices = (result: z.infer<typeof toolResultSchema>) => result.content.slice(1).map(({ text }) => text);
  const outline = async (doc?: string) => outlineSchema.parse(await json('get_outline', doc === undefined ? {} : { doc }));
  const textOf = async (doc: string, id: string) => (await outline(doc)).blocks.find((block) => block.id === id)?.text;

  /** 탭 하나를 붙여 rhwp 테스트 뷰어로 요청을 처리한다(url 이 문서 탭 주소면 새로고침한 탭, 아니면 빈 탭) */
  const connectTab = async (url: string): Promise<Tab> => {
    const socket = await FakeViewer.connect(url);
    sockets.push(socket);
    const rhwp = rhwpViewer();
    socket.serve(rhwp.handle);
    return { socket, rhwp };
  };
  const tab = (doc: string): Tab => {
    const found = tabs.get(doc);
    if (found === undefined) throw new Error(`${doc} 탭이 없다`);
    return found;
  };

  /** 임시 폴더에 fixture 를 복사해 둔다(같은 내용의 다른 파일) */
  const copy = async (fixture: string, name: string) => {
    const path = join(dir, name);
    await copyFile(fixturePath(fixture), path);
    return path;
  };

  /** 탭이 보는 블록 위치(그 문서 id 표와 같다) */
  const anchorOf = (doc: string, id: string): BlockAnchor => {
    const anchor = sessions.get(doc).document?.ids.anchor(id);
    if (anchor === undefined) throw new Error(`${doc} ${id} 가 없다`);
    return anchor;
  };

  /** 탭을 닫는다(연결이 끊기고 다시 붙지 않는다) */
  const closeTab = async (doc: string) => {
    const disconnected = once(bridge.events, 'disconnected');
    tab(doc).socket.close();
    await disconnected;
  };

  /** 서버를 띄운다. tabCloseGraceMs = 탭을 닫았다고 보기까지 기다리는 시간 */
  const start = async (tabCloseGraceMs: number) => {
    bridge = await startBridge({ port: 0, viewerDir: tmpdir() });
    tabs = new Map();
    // 브라우저 대신: 문서 탭 주소를 열면 그 주소로 탭이 붙는다
    openBrowser = vi.fn<(url: string) => void>((url) => {
      const doc = new URL(url).searchParams.get('doc') ?? '';
      void connectTab(url).then((opened) => tabs.set(doc, opened));
    });
    sessions = new DocumentSessions(bridge, { openBrowser, tabCloseGraceMs });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(sessions).connect(serverSide);
    client = new Client({ name: 'docbridge-test', version: '0.0.0' });
    await client.connect(clientSide);
  };
  const stop = async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await client.close();
    await bridge.close();
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'docbridge-multi-'));
    // 탭을 닫았다고 보는 시간은 0(타이머 순서로 기다린다 — 시간에 기대지 않게)
    await start(0);
  });

  afterEach(stop);

  it('AC-1 두 파일을 열면 탭 두 개, doc 이 d1·d2 로 나온다. 같은 파일을 다시 열면 새 탭 없이 같은 doc 이다', async () => {
    const first = await json('open_document', { path: fixturePath('notice.hwpx') });
    const second = await json('open_document', { path: fixturePath('report.hwpx') });

    expect(first).toMatchObject({ doc: 'd1', fileName: 'notice.hwpx', viewerUrl: bridge.viewerUrlFor('d1') });
    expect(second).toMatchObject({ doc: 'd2', fileName: 'report.hwpx', viewerUrl: bridge.viewerUrlFor('d2') });
    // 결과 맨 위가 doc
    expect(Object.keys(z.object({}).loose().parse(first))[0]).toBe('doc');
    expect(openBrowser.mock.calls).toEqual([[bridge.viewerUrlFor('d1')], [bridge.viewerUrlFor('d2')]]);
    expect(tab('d1').rhwp.editor().doc).not.toBe(tab('d2').rhwp.editor().doc);

    expect(await json('open_document', { path: fixturePath('notice.hwpx') })).toMatchObject({ doc: 'd1' });
    expect(openBrowser).toHaveBeenCalledTimes(2);
    expect(tab('d1').socket.history.filter(({ method }) => method === 'load_document')).toHaveLength(2);
    expect(tab('d2').socket.history.filter(({ method }) => method === 'load_document')).toHaveLength(1);
  });

  it('AC-1 빈 탭(문서 이름 없이 붙은 뷰어)이 있으면 새 탭을 열지 않고 그 탭에 문서 이름을 알려 띄운다', async () => {
    const blank = await connectTab(bridge.viewerUrl);

    expect(await json('open_document', { path: fixturePath('notice.hwpx') })).toMatchObject({ doc: 'd1' });

    expect(openBrowser).not.toHaveBeenCalled();
    expect(blank.socket.history[0]).toMatchObject({ method: 'load_document', params: { doc: 'd1', fileName: 'notice.hwpx' } });
  });

  it('AC-1 같은 파일은 실제 경로(realpath)로 가린다 — 링크로 가리킨 경로(macOS /tmp ↔ /private/tmp 등)로 다시 열어도 같은 doc 이다', async () => {
    const path = await copy('notice.hwpx', '공문.hwpx');
    const linked = join(dir, '링크');
    await symlink(dir, linked);

    expect(await json('open_document', { path })).toMatchObject({ doc: 'd1' });
    expect(await json('open_document', { path: join(linked, '공문.hwpx') })).toMatchObject({ doc: 'd1' });
    expect(sessions.list().documents).toHaveLength(1);
  });

  it('열린 다른 문서의 파일 경로로는 저장하지 않는다(두 문서가 같은 파일을 가리키지 않게, 링크 경로도)', async () => {
    const first = await copy('notice.hwpx', '공문.hwpx');
    await json('open_document', { path: first });
    await json('open_document', { path: fixturePath('report.hwpx') });
    await json('replace_text', { doc: 'd1', target: { id: 'b1' }, text: '라마바구청' });
    const bytes = await readFile(first);
    const linked = join(dir, '링크');
    await symlink(dir, linked);

    const refused = `d1 이 이 파일을 열고 있습니다: ${first}. 다른 경로에 저장하거나 d1 을 close_document 로 닫은 뒤 저장하세요.`;
    expect(await errorText('save_document', { doc: 'd2', path: first, overwrite: true })).toBe(refused);
    expect(await errorText('save_document', { doc: 'd2', path: join(linked, '공문.hwpx'), overwrite: true })).toContain('d1 이 이 파일을 열고 있습니다');
    expect(await readFile(first)).toEqual(bytes);
    expect(sessions.get('d1').unsavedEdits).toBe(1);
    // 자기 파일 덮어쓰기는 그대로 된다
    expect(await json('save_document', { doc: 'd1', path: first, overwrite: true })).toMatchObject({ doc: 'd1', path: first });
  });

  it('AC-2 doc 없이 부른 도구는 마지막으로 쓴 문서(마지막으로 열었거나 도구 대상이 된 문서)를 대상으로 한다', async () => {
    await json('open_document', { path: fixturePath('notice.hwpx') });
    await json('open_document', { path: fixturePath('report.hwpx') });

    expect((await outline()).doc).toBe('d2');
    expect((await outline('d1')).doc).toBe('d1');
    expect((await outline()).doc).toBe('d1');
    expect(await json('list_documents')).toMatchObject({ documents: [{ doc: 'd1', current: true }, { doc: 'd2', current: false }] });
  });

  it('AC-3 문서마다 블록 id·되돌리기·저장하지 않은 편집 수가 따로다', async () => {
    await json('open_document', { path: fixturePath('notice.hwpx') });
    // 같은 내용의 다른 파일: b1 이 같은 글자라 섞이면 바로 보인다
    await json('open_document', { path: await copy('notice.hwpx', '공문 사본.hwpx') });

    await json('replace_text', { doc: 'd1', target: { id: 'b1' }, text: '라마바구청' });

    expect(await textOf('d1', 'b1')).toBe('라마바구청');
    expect(await textOf('d2', 'b1')).toBe('가나다구청');
    expect([sessions.get('d1').unsavedEdits, sessions.get('d2').unsavedEdits]).toEqual([1, 0]);
    expect(await errorText('undo', { doc: 'd2' })).toBe(NOTHING_TO_UNDO);
    expect(await json('undo', { doc: 'd1' })).toMatchObject({ doc: 'd1', undone: 1 });
    expect(await textOf('d1', 'b1')).toBe('가나다구청');

    // 문단을 넣으면 그 문서 id 표만 옮겨진다
    expect(await json('insert_paragraph', { doc: 'd2', after: 'b1', text: '새 문단' })).toMatchObject({ doc: 'd2', inserted: 'b15' });
    expect((await outline('d1')).blocks.map(({ id }) => id)).not.toContain('b15');
  });

  it('AC-3 문서마다 직렬 큐가 따로라, 한 문서의 편집 응답을 기다리는 동안에도 다른 문서 도구는 끝난다', async () => {
    await json('open_document', { path: fixturePath('notice.hwpx') });
    await json('open_document', { path: fixturePath('report.hwpx') });
    // d1 탭의 편집 응답을 붙잡는다
    const d1 = tab('d1');
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      d1.socket.serve((request: RequestMessage) => {
        const result = d1.rhwp.handle(request);
        if (request.method !== 'edit') return result;
        release = () => d1.socket.respondWith(request.id, result);
        resolve();
        return NO_RESPONSE;
      });
    });
    const editing = json('replace_text', { doc: 'd1', target: { id: 'b1' }, text: '라마바구청' });
    await held;

    expect((await outline('d2')).doc).toBe('d2');
    release();
    expect(await editing).toMatchObject({ doc: 'd1' });
  });

  it('AC-4 list_documents 는 열린 문서를 연 순서로, 파일·쪽 수·저장하지 않은 편집 수·current 와 함께 돌려준다', async () => {
    const notice = fixturePath('notice.hwpx');
    await json('open_document', { path: notice });
    const newPath = join(dir, '제안서.hwpx');
    await json('create_document', { path: newPath });
    await json('replace_text', { doc: 'd1', target: { id: 'b1' }, text: '라마바구청' });

    expect(await json('list_documents')).toEqual({
      documents: [
        { doc: 'd1', fileName: 'notice.hwpx', path: notice, pageCount: 1, unsavedEdits: 1, current: true },
        { doc: 'd2', fileName: '제안서.hwpx', path: newPath, newDocument: true, pageCount: 1, unsavedEdits: 0, current: false },
      ],
    });
  });

  it('AC-4 close_document 는 저장하지 않은 편집이 있으면 닫지 않고, discard: true 면 버리고 닫는다. 닫은 이름은 다시 쓰지 않는다', async () => {
    await json('open_document', { path: fixturePath('notice.hwpx') });
    await json('open_document', { path: fixturePath('report.hwpx') });
    await json('replace_text', { doc: 'd1', target: { id: 'b1' }, text: '라마바구청' });

    expect(await errorText('close_document', { doc: 'd1' })).toBe('저장하지 않은 편집 1개가 있습니다. 저장하거나 discard: true 로 닫아 주세요.');
    expect(sessions.list().documents.map(({ doc }) => doc)).toEqual(['d1', 'd2']);

    expect(await json('close_document', { doc: 'd1', discard: true })).toEqual({
      doc: 'd1',
      closed: true,
      warnings: ['저장하지 않은 편집 1개를 버렸습니다'],
    });
    expect(tab('d1').socket.history.at(-1)?.method).toBe('close_document');
    expect(sessions.list().documents.map(({ doc }) => doc)).toEqual(['d2']);
    expect(await errorText('get_outline', { doc: 'd1' })).toBe('열린 문서에 d1 가 없습니다. list_documents 로 확인해 주세요.');
    // 편집이 없으면 그냥 닫는다
    expect(await json('close_document', { doc: 'd2' })).toEqual({ doc: 'd2', closed: true });

    // 닫은 탭은 빈 탭이 되어 다음 문서가 쓰고, 이름은 새로 매긴다
    expect(await json('open_document', { path: fixturePath('notice.hwpx') })).toMatchObject({ doc: 'd3' });
    expect(openBrowser).toHaveBeenCalledTimes(2);
  });

  it('없는 doc 이름이면 list_documents 로 확인하라고 한다', async () => {
    await json('open_document', { path: fixturePath('notice.hwpx') });

    expect(await errorText('get_outline', { doc: 'd5' })).toBe('열린 문서에 d5 가 없습니다. list_documents 로 확인해 주세요.');
  });

  it(`AC-7 ${MAX_DOCUMENTS + 1}번째 문서를 열면 거부한다(이미 열린 파일을 다시 여는 것은 된다)`, async () => {
    // 렌더링은 필요 없다: 탭은 블록 위치만 돌려준다
    openBrowser.mockImplementation((url) => {
      void FakeViewer.connect(url).then((socket) => {
        sockets.push(socket);
        socket.autoRespond({ pageCount: 1, blocks: paragraphBlocks(3) });
      });
    });
    const paths = await Promise.all(Array.from({ length: MAX_DOCUMENTS + 1 }, (_, i) => copy('notice.hwpx', `공문${i + 1}.hwpx`)));
    for (const path of paths.slice(0, MAX_DOCUMENTS)) await json('open_document', { path });

    expect(await errorText('open_document', { path: paths[MAX_DOCUMENTS] })).toBe(TOO_MANY_DOCUMENTS);
    expect(TOO_MANY_DOCUMENTS).toBe('열린 문서가 8개입니다. close_document 로 닫아 주세요.');
    expect(await errorText('create_document', { path: join(dir, '새 문서.hwpx') })).toBe(TOO_MANY_DOCUMENTS);
    expect(await json('open_document', { path: paths[0] })).toMatchObject({ doc: 'd1' });
    expect(openBrowser).toHaveBeenCalledTimes(MAX_DOCUMENTS);
  });

  it('AC-8 사용자가 탭을 닫으면 그 문서가 빠지고 다음 도구 결과에 한 번 알린다', async () => {
    await json('open_document', { path: fixturePath('notice.hwpx') });
    await json('open_document', { path: fixturePath('report.hwpx') });
    await json('replace_text', { doc: 'd2', target: { id: 'b1' }, text: '고친 제목' });

    await closeTab('d2');
    // 닫았다고 보는 타이머(0ms)가 먼저 돈다
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await call('get_outline', { doc: 'd1' });
    expect(notices(result)).toEqual(['d2 탭이 닫혀 문서를 닫았습니다(저장하지 않은 편집 1개를 버렸습니다)']);
    expect(notices(await call('get_outline'))).toEqual([]);
    expect(sessions.list().documents.map(({ doc }) => doc)).toEqual(['d1']);
    // 마지막으로 쓴 문서가 닫혔으면 그 앞에 쓴 문서가 대상이다
    expect((await outline()).doc).toBe('d1');
  });

  it('탭을 새로고침하면(곧 같은 문서 이름으로 다시 붙으면) 문서를 빼지 않고 그 문서만 다시 띄운다', async () => {
    // 새로고침은 연결이 끊긴 뒤 다시 붙는다 — 그 사이에 닫았다고 보지 않게 넉넉히
    await stop();
    await start(60_000);
    await json('open_document', { path: fixturePath('notice.hwpx') });
    await json('open_document', { path: fixturePath('report.hwpx') });
    await json('replace_text', { doc: 'd1', target: { id: 'b1' }, text: '라마바구청' });

    // 이전 연결이 끊기고 같은 주소(문서 이름 포함)로 새 연결이 붙는다
    await closeTab('d1');
    const reloaded = await connectTab(bridge.viewerUrlFor('d1'));
    tabs.set('d1', reloaded);
    await sessions.ready();

    const result = await call('get_outline', { doc: 'd2' });
    expect(notices(result)).toEqual(['d1: 뷰어를 새로고침해서 저장하지 않은 편집 1개가 사라졌습니다.']);
    expect(sessions.list().documents.map(({ doc }) => doc)).toEqual(['d1', 'd2']);
    expect(await textOf('d1', 'b1')).toBe('가나다구청');
    expect(reloaded.socket.history[0]).toMatchObject({ method: 'load_document', params: { doc: 'd1' } });
  });

  it('사람 편집은 그 탭 문서로 가고, 다른 문서의 Claude 편집은 그 문서 상태 번호를 바꾸지 않는다', async () => {
    await json('open_document', { path: fixturePath('notice.hwpx') });
    await json('open_document', { path: await copy('notice.hwpx', '공문 사본.hwpx') });
    // d1 탭은 상태 0 을 보고 있다. 그사이 d2 에 Claude 편집이 든다
    await json('replace_text', { doc: 'd2', target: { id: 'b1' }, text: '마바사구청' });

    const response: UserResponseMessage = await tab('d1').socket.userRequest('user_edit', {
      edit: { kind: 'replace_text', target: { anchor: anchorOf('d1', 'b1') }, text: '라마바구청' },
      state: 0,
    });

    expect(response.ok).toBe(true);
    expect([await textOf('d1', 'b1'), await textOf('d2', 'b1')]).toEqual(['라마바구청', '마바사구청']);
    expect([sessions.get('d1').editCount, sessions.get('d2').editCount]).toEqual([1, 1]);
    // ⌘Z 도 그 탭 문서의 되돌리기 줄에서
    expect(await tab('d2').socket.userRequest('user_undo', {})).toMatchObject({ ok: true, result: { undone: ['replace_text b1'] } });
    expect([await textOf('d1', 'b1'), await textOf('d2', 'b1')]).toEqual(['라마바구청', '가나다구청']);
  });

  it('다른 문서의 알림은 문서 이름을 앞에 붙이고, 대상 문서의 알림은 그대로 붙인다', async () => {
    await json('open_document', { path: fixturePath('notice.hwpx') });
    await json('open_document', { path: fixturePath('report.hwpx') });
    const edit = { kind: 'replace_text' as const, target: { anchor: anchorOf('d1', 'b1') }, text: '라마바구청' };
    expect((await tab('d1').socket.userRequest('user_edit', { edit, state: 0 })).ok).toBe(true);

    expect(notices(await call('get_outline', { doc: 'd2' }))).toEqual(['d1: 사용자가 화면에서 고침: b1 글자']);

    expect((await tab('d1').socket.userRequest('user_undo', {})).ok).toBe(true);
    expect(notices(await call('get_outline', { doc: 'd1' }))).toEqual(['사용자가 화면에서 고침: 되돌림(replace_text b1 (사용자 화면 편집))']);
  });

  it('닫은 문서 탭은 빈 탭이라 그 탭이 보낸 사람 편집은 받지 않는다', async () => {
    await json('open_document', { path: fixturePath('notice.hwpx') });
    const anchor = anchorOf('d1', 'b1');
    await json('close_document');

    const response = await tab('d1').socket.userRequest('user_edit', { edit: { kind: 'replace_text', target: { anchor }, text: 'X' }, state: 0 });

    expect(response).toMatchObject({ ok: false, error: INACTIVE_VIEWER });
  });
});
