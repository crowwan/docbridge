import { once } from 'node:events';
import { tmpdir } from 'node:os';
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
import { FakeViewer } from './fake-viewer.ts';
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
  /** 뷰어가 지금 편집 순번으로 사람 편집을 보낸다 */
  const userEdit = (edit: UserEdit, depth = session.document?.edits.depth ?? 0) => viewer.userRequest('user_edit', { edit, depth });
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
    viewer.serve(rhwpViewer().handle);
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

  it('사람 편집은 Claude 편집과 같은 직렬 큐로 처리해 편집 순번·저장하지 않은 편집 수를 이어서 싣는다', async () => {
    await json('replace_text', { target: { id: 'b1' }, text: '라마바구청' });

    succeeded(await userEdit(replaceB11()));

    expect(requests('edit').map(({ params }) => ('depth' in params ? [params.depth, params.unsavedEdits] : []))).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(session.unsavedEdits).toBe(2);
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

  it('뷰어의 편집 순번이 서버와 다르면(그사이 문서가 바뀜) 뷰어에 보내지 않고 거부한다', async () => {
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
    ws.send(JSON.stringify({ type: 'user_request', id: 7, method: 'user_edit', params: { edit: { kind: 'insert_table' }, depth: 0 } }));

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
