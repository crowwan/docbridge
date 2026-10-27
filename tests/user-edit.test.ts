import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { BlockAnchor } from '../src/core/block-ids.ts';
import { INACTIVE_VIEWER, startBridge, type Bridge } from '../src/server/bridge.ts';
import { NOTHING_TO_UNDO } from '../src/server/edit-tools.ts';
import { createMcpServer } from '../src/server/mcp.ts';
import { DocumentSession } from '../src/server/session.ts';
import { STALE_USER_EDIT } from '../src/server/user-edit.ts';
import type { RequestMessage, UserEdit, UserResponseMessage } from '../src/shared/protocol.ts';
import { FakeViewer, NO_RESPONSE } from './fake-viewer.ts';
import { fixturePath } from './fixtures.ts';
import { rhwpViewer } from './rhwp-viewer.ts';

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});
const outlineSchema = z.object({ blocks: z.array(z.object({ id: z.string() })) });

const B11_BEFORE = '회신 기한: 2026. 11. 14.(금)까지 참석 인원을 회신하여 주시기 바랍니다.';
const B11_AFTER = '회신 기한: 2026. 11. 7.(금)까지 참석 인원을 회신하여 주시기 바랍니다.';

describe('SPEC-006 뷰어 → 서버 사람 편집 요청과 공용 되돌리기·알림', () => {
  let bridge: Bridge;
  let session: DocumentSession;
  let client: Client;
  let viewer: FakeViewer;
  const sockets: FakeViewer[] = [];

  const call = async (name: string, args: Record<string, unknown> = {}) =>
    toolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const json = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const result = await call(name, args);
    if (result.isError) throw new Error(result.content[0]?.text);
    return JSON.parse(result.content[0]?.text ?? '');
  };
  /** get_outline 의 블록 id(문서 순서)와 붙은 알림 */
  const outline = async () => {
    const result = await call('get_outline');
    return {
      ids: outlineSchema.parse(JSON.parse(result.content[0]?.text ?? '')).blocks.map(({ id }) => id),
      notices: result.content.slice(1).map(({ text }) => text),
    };
  };
  const readText = async (id: string) => {
    const { blocks } = z.object({ blocks: z.array(z.object({ text: z.string().optional() })) }).parse(await json('read_blocks', { ids: [id] }));
    return blocks[0]?.text;
  };
  const requests = (method: RequestMessage['method']) => viewer.history.filter((request) => request.method === method);
  /** 뷰어가 가진 블록 위치(서버 id 표와 같다) */
  const anchorOf = (id: string): BlockAnchor => {
    const anchor = session.document?.ids.anchor(id);
    if (anchor === undefined) throw new Error(`${id} 가 없다`);
    return anchor;
  };
  /** 서버가 아는 지금 문서 상태 번호(뷰어가 마지막으로 받은 편집·되돌리기의 상태 번호와 같다) */
  const serverState = () => session.document?.edits.state ?? 0;
  /** 뷰어가 보고 있는 문서의 상태 번호로 사람 편집을 보낸다 */
  const userEdit = (edit: UserEdit, state = serverState()) => viewer.userRequest('user_edit', { edit, state });
  /**
   * 뷰어 응답 붙잡기: holdNext(method) 뒤 오는 그 요청은 뷰어가 처리만 하고 응답은 release() 때 보낸다.
   * 뷰어는 적용(또는 문서를 바꿈)했지만 서버는 아직 기록하지 않은 사이를 시간에 기대지 않고 만든다
   */
  let holding: { method: RequestMessage['method']; resolve: (held: { request: RequestMessage; release: () => void }) => void } | undefined;
  const holdNext = (method: RequestMessage['method']) =>
    new Promise<{ request: RequestMessage; release: () => void }>((resolve) => (holding = { method, resolve }));
  const holdNextEdit = () => holdNext('edit');
  const succeeded = (response: UserResponseMessage) => {
    if (!response.ok) throw new Error(response.error);
    return response.result;
  };
  const failure = (response: UserResponseMessage) => (response.ok ? undefined : response.error);
  const replaceB11: () => UserEdit = () => ({ kind: 'replace_text', target: { anchor: anchorOf('b11'), start: 13, end: 20 }, text: '11. 7.' });

  beforeEach(async () => {
    bridge = await startBridge({ port: 0, viewerDir: tmpdir() });
    session = new DocumentSession(bridge, { openBrowser: vi.fn() });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(session).connect(serverSide);
    client = new Client({ name: 'docbridge-test', version: '0.0.0' });
    await client.connect(clientSide);
    viewer = await FakeViewer.connect(bridge.viewerUrl);
    sockets.push(viewer);
    const rhwp = rhwpViewer();
    viewer.serve((request) => {
      const result = rhwp.handle(request);
      const hold = holding;
      if (hold === undefined || request.method !== hold.method) return result;
      holding = undefined;
      hold.resolve({ request, release: () => viewer.respondWith(request.id, result) });
      return NO_RESPONSE;
    });
    await json('open_document', { path: fixturePath('notice.hwpx') });
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await client.close();
    await bridge.close();
  });

  it('AC-6 사람 편집 뒤 read_blocks 가 고친 글자를 돌려주고 기존 블록 id 는 그대로다', async () => {
    const before = (await outline()).ids;

    succeeded(await userEdit(replaceB11()));

    expect(await readText('b11')).toBe(B11_AFTER);
    expect((await outline()).ids).toEqual(before);
  });

  it('AC-6 사람이 옮긴 순서를 get_outline 이 돌려주고 블록 id 는 그대로다', async () => {
    const before = (await outline()).ids;

    succeeded(await userEdit({ kind: 'move_blocks', blocks: [anchorOf('b11')], where: 'before', reference: anchorOf('b6') }));

    const after = (await outline()).ids;
    expect(after.slice(4, 8)).toEqual(['b5', 'b11', 'b6', 'b7']);
    expect([...after].sort()).toEqual([...before].sort());
  });

  it('사람이 지운 블록은 get_outline 에서 빠지고 남은 블록 id 는 그대로다', async () => {
    const before = (await outline()).ids;

    succeeded(await userEdit({ kind: 'delete_blocks', targets: [anchorOf('b4')] }));

    expect((await outline()).ids).toEqual(before.filter((id) => id !== 'b4'));
  });

  it('사람 편집은 Claude 편집과 같은 직렬 큐로 처리해 편집 순번·저장하지 않은 편집 수·상태 번호를 이어서 싣는다', async () => {
    await json('replace_text', { target: { id: 'b1' }, text: '라마바구청' });

    succeeded(await userEdit(replaceB11()));

    expect(requests('edit').map(({ params }) => ('depth' in params ? [params.depth, params.unsavedEdits] : []))).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(session.unsavedEdits).toBe(2);
    // 편집 요청마다 편집 뒤 상태 번호를 실어 보낸다(뷰어가 사람 편집에 실어 돌려준다)
    expect(requests('edit').map(({ params }) => ('state' in params ? params.state : undefined))).toEqual([1, 2]);
    expect(serverState()).toBe(2);
  });

  it('뷰어가 Claude 편집을 받기 전에 보낸 사람 편집(옛 상태 번호)은 그 편집이 기록된 뒤 차례가 와도 거부한다', async () => {
    const held = holdNextEdit();
    const claude = json('replace_text', { target: { id: 'b1' }, text: '라마바구청' });
    const { release } = await held;

    // 뷰어는 Claude 편집 전 화면(상태 0)을 보고 고쳤다
    const user = userEdit(replaceB11(), 0);
    release();
    await claude;

    expect(failure(await user)).toBe(STALE_USER_EDIT);
    expect(await readText('b11')).toBe(B11_BEFORE);
    expect(session.editCount).toBe(1);
  });

  it('뷰어가 Claude 편집을 적용한 뒤 보낸 사람 편집(새 상태 번호)은 서버 기록이 끝나기 전에 와도 그 뒤에 적용한다', async () => {
    const held = holdNextEdit();
    const claude = json('replace_text', { target: { id: 'b1' }, text: '라마바구청' });
    const { request, release } = await held;
    const applied = 'state' in request.params ? request.params.state : undefined;

    // 뷰어는 Claude 편집을 적용한 화면(요청에 실려 온 상태 번호)에서 고쳤다. 서버는 아직 그 편집을 기록하지 않았다
    const user = userEdit(replaceB11(), applied);
    release();
    await claude;

    succeeded(await user);
    expect(await readText('b1')).toBe('라마바구청');
    expect(await readText('b11')).toBe(B11_AFTER);
    expect(session.editCount).toBe(2);
  });

  it('문서를 바꾸기 전 화면에서 보낸 사람 편집은 새 문서에 적용하지 않고 거부한다 (open_document — 새 문서도 상태 번호 0)', async () => {
    const held = holdNext('load_document');
    // 같은 파일을 다시 열어 블록 위치가 같다 — 위치·번호만 보면 새 문서에 그대로 적용된다
    const opening = json('open_document', { path: fixturePath('notice.hwpx') });
    const { release } = await held;

    // 뷰어는 열기 응답 전, 이전 문서 화면(상태 0)에서 고쳤다
    const user = userEdit(replaceB11(), 0);
    release();
    await opening;

    expect(failure(await user)).toBe(STALE_USER_EDIT);
    expect(await readText('b11')).toBe(B11_BEFORE);
    expect(session.editCount).toBe(0);
    expect((await outline()).notices).toEqual([]);
  });

  it('문서를 바꾸기 전 화면에서 보낸 사람 편집은 새로 만든 문서에도 적용하지 않고 거부한다 (create_document)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docbridge-user-edit-'));
    const held = holdNext('create_document');
    const creating = json('create_document', { path: join(dir, '새 문서.hwpx') });
    const { release } = await held;

    // 새 문서의 첫 문단도 이전 문서 b1 과 같은 위치다
    const user = userEdit({ kind: 'replace_text', target: { anchor: anchorOf('b1') }, text: '이전 문서에서 고친 글자' }, 0);
    release();
    await creating;

    expect(failure(await user)).toBe(STALE_USER_EDIT);
    expect(await readText('b1')).toBe('');
    expect(session.editCount).toBe(0);
  });

  it('문서를 바꾸기 전 화면에서 누른 ⌘Z 는 새 문서에 쓰지 않고 거부한다', async () => {
    const held = holdNext('load_document');
    const opening = json('open_document', { path: fixturePath('notice.hwpx') });
    const { release } = await held;

    const undo = viewer.userRequest('user_undo', {});
    release();
    await opening;

    expect(failure(await undo)).toBe(STALE_USER_EDIT);
    expect(requests('undo')).toEqual([]);
  });

  it('문서를 바꾸면 이전 문서에서 사람이 고친 알림은 버린다(새 문서의 블록 id 와 헷갈리지 않게)', async () => {
    succeeded(await userEdit(replaceB11()));

    const opened = await call('open_document', { path: fixturePath('notice.hwpx') });

    expect(opened.content.slice(1)).toEqual([]);
    expect((await outline()).notices).toEqual([]);
  });

  it('뷰어를 새로고침하면 사람이 고친 알림 대신 사라진 편집 수만 알린다', async () => {
    succeeded(await userEdit(replaceB11()));

    const newer = await FakeViewer.connect(bridge.viewerUrl);
    sockets.push(newer);
    newer.serve(rhwpViewer().handle);
    await session.ready();

    expect((await outline()).notices).toEqual(['뷰어를 새로고침해서 저장하지 않은 편집 1개가 사라졌습니다.']);
  });

  it('사람 편집 지우기에 같은 블록 위치가 두 번 와도 한 번만 지운다(Claude delete_blocks 와 같게)', async () => {
    succeeded(await userEdit({ kind: 'delete_blocks', targets: [anchorOf('b4'), anchorOf('b4')] }));

    const last = requests('edit').at(-1)?.params;
    expect(last !== undefined && 'operation' in last && last.operation.kind === 'delete_blocks' ? last.operation.targets.map(({ id }) => id) : []).toEqual(['b4']);
    expect((await outline()).notices).toEqual(['사용자가 화면에서 고침: b4 지움']);
  });

  it('되돌린 뒤 다른 편집으로 편집 순번이 같아져도 상태 번호가 다르면 거부한다', async () => {
    await json('replace_text', { target: { id: 'b1' }, text: '라마바구청' });
    const seen = serverState();
    await json('undo');
    await json('insert_paragraph', { after: 'b5', text: '새 문단' });
    expect(session.document?.edits.depth).toBe(1);

    expect(failure(await userEdit(replaceB11(), seen))).toBe(STALE_USER_EDIT);
    expect(await readText('b11')).toBe(B11_BEFORE);
  });

  it('AC-7 사람 편집과 Claude 편집이 한 되돌리기 줄에 쌓이고, undo 가 사람 편집도 순서대로 되돌린다', async () => {
    succeeded(await userEdit(replaceB11()));
    await json('replace_text', { target: { id: 'b1' }, text: '라마바구청' });

    expect(await json('undo', { steps: 2 })).toEqual({
      undone: 2,
      edits: ['replace_text b1', 'replace_text b11 (사용자 화면 편집)'],
    });
    expect(await readText('b1')).toBe('가나다구청');
    expect(await readText('b11')).toBe(B11_BEFORE);
  });

  it('AC-7 ⌘Z(user_undo)는 마지막 편집이 Claude 것이어도 같은 줄에서 되돌리고, 더 없으면 거부한다', async () => {
    succeeded(await userEdit(replaceB11()));
    await json('replace_text', { target: { id: 'b1' }, text: '라마바구청' });

    expect(succeeded(await viewer.userRequest('user_undo', {}))).toEqual({ undone: ['replace_text b1'] });
    expect(await readText('b1')).toBe('가나다구청');
    expect(succeeded(await viewer.userRequest('user_undo', {}))).toEqual({ undone: ['replace_text b11 (사용자 화면 편집)'] });
    expect(await readText('b11')).toBe(B11_BEFORE);

    expect(failure(await viewer.userRequest('user_undo', {}))).toBe(NOTHING_TO_UNDO);
    expect(session.editCount).toBe(0);
  });

  it('AC-9 사람 편집 뒤 다음 도구 결과에 notices 로 한 번 알린다', async () => {
    succeeded(await userEdit(replaceB11()));
    succeeded(await userEdit({ kind: 'move_blocks', blocks: [anchorOf('b6')], where: 'after', reference: anchorOf('b7') }));

    expect((await outline()).notices).toEqual(['사용자가 화면에서 고침: b11 글자, b6 옮김']);
    expect((await outline()).notices).toEqual([]);
  });

  it('AC-9 사람이 지운 블록과 ⌘Z 로 되돌린 편집도 알린다', async () => {
    succeeded(await userEdit({ kind: 'delete_blocks', targets: [anchorOf('b4')] }));
    succeeded(await viewer.userRequest('user_undo', {}));

    expect((await outline()).notices).toEqual(['사용자가 화면에서 고침: b4 지움, 되돌림(delete_blocks b4 (사용자 화면 편집))']);
  });

  it('Claude 편집만 있으면 알림이 붙지 않는다', async () => {
    await json('replace_text', { target: { id: 'b1' }, text: '라마바구청' });

    expect((await outline()).notices).toEqual([]);
  });

  it('뷰어의 상태 번호가 서버와 다르면(그사이 문서가 바뀜) 뷰어에 보내지 않고 거부한다', async () => {
    expect(failure(await userEdit(replaceB11(), 3))).toBe(STALE_USER_EDIT);

    expect(requests('edit')).toEqual([]);
    expect(session.editCount).toBe(0);
    expect((await outline()).notices).toEqual([]);
  });

  it('거부 규칙은 Claude 편집과 같다: 구역 첫 문단은 지우지 않고 기록·알림도 남기지 않는다', async () => {
    const error = failure(await userEdit({ kind: 'delete_blocks', targets: [anchorOf('b1')] }));

    expect(error).toContain('구역 첫 문단은 지울 수 없습니다');
    expect(requests('edit')).toEqual([]);
    expect(session.editCount).toBe(0);
    expect((await outline()).notices).toEqual([]);
  });

  it('id 표에 없는 블록 위치면 거부한다', async () => {
    const error = failure(await userEdit({ kind: 'replace_text', target: { anchor: { section: 0, paragraph: 999, part: 'text' } }, text: 'X' }));

    expect(error).toBe('뷰어 화면의 블록을 찾지 못했습니다. 뷰어 탭을 새로고침하세요.');
  });

  it('서버가 읽을 수 없는 뷰어 요청에도 같은 id 로 오류 응답한다(뷰어가 타임아웃까지 기다리지 않게)', async () => {
    // 지금 뷰어 탭을 대신하는 새 연결(요청을 받는 뷰어)로 보낸다
    const ws = new WebSocket(bridge.viewerUrl.replace('http://', 'ws://'));
    await once(ws, 'open');
    const responseSchema = z.object({ type: z.literal('user_response'), id: z.number(), ok: z.boolean(), error: z.string() });
    // 새로고침으로 오는 load_document 요청은 건너뛰고 응답만 기다린다
    const reply = new Promise<z.infer<typeof responseSchema>>((resolve) => {
      ws.on('message', (data) => {
        const parsed = responseSchema.safeParse(JSON.parse(String(data)));
        if (parsed.success) resolve(parsed.data);
      });
    });
    ws.send(JSON.stringify({ type: 'user_request', id: 7, method: 'user_edit', params: { edit: { kind: 'insert_table' }, state: 0 } }));

    const response = await reply;
    ws.close();

    expect(response).toMatchObject({ id: 7, ok: false });
    expect(response.error).toContain('서버가 읽을 수 없는 뷰어 요청입니다');
  });

  it('요청을 받는 뷰어가 아닌 이전 탭의 사람 편집은 거부한다', async () => {
    const newer = await FakeViewer.connect(bridge.viewerUrl);
    sockets.push(newer);
    newer.serve(rhwpViewer().handle);
    await session.ready();

    expect(failure(await userEdit(replaceB11()))).toBe(INACTIVE_VIEWER);
    expect(session.editCount).toBe(0);
  });
});
