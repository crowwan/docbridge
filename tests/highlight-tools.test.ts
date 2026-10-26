import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { createMcpServer } from '../src/server/mcp.ts';
import { DocumentSession } from '../src/server/session.ts';
import { NOTE_MAX_CHARS, type RequestMessage } from '../src/shared/protocol.ts';
import { FakeViewer } from './fake-viewer.ts';
import { fixturePath } from './fixtures.ts';
import { rhwpViewerHandler } from './rhwp-viewer.ts';

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});
const matchesSchema = z.object({ matches: z.array(z.record(z.string(), z.unknown())) });

describe('SPEC-001 근거 하이라이트 도구 (highlight · clear_highlight)', () => {
  let bridge: Bridge;
  let session: DocumentSession;
  let client: Client;
  let viewer: FakeViewer;

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
  const highlightRequests = () =>
    viewer.history.filter((request): request is Extract<RequestMessage, { method: 'highlight' }> => request.method === 'highlight');

  beforeEach(async () => {
    bridge = await startBridge({ port: 0, viewerDir: tmpdir() });
    session = new DocumentSession(bridge, { openBrowser: vi.fn() });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(session).connect(serverSide);
    client = new Client({ name: 'docbridge-test', version: '0.0.0' });
    await client.connect(clientSide);
    viewer = await FakeViewer.connect(bridge.viewerUrl);
    viewer.serve(rhwpViewerHandler());
    await json('open_document', { path: fixturePath('notice.hwpx') });
  });

  afterEach(async () => {
    viewer.close();
    await client.close();
    await bridge.close();
  });

  it('highlight 는 대상의 블록 id 를 문서 위치로 바꿔 뷰어에 그리게 하고, 그린 대상 수와 쪽을 돌려준다', async () => {
    const result = await json('highlight', { targets: [{ id: 'b1' }, { id: 'b12', cell: { row: 2, col: 2 } }], note: ' 근거 ' });

    expect(result).toEqual({ highlighted: 2, pages: [1] });
    expect(highlightRequests().at(-1)?.params).toEqual({
      targets: [
        { id: 'b1', anchor: { section: 0, paragraph: 0, part: 'text' } },
        { id: 'b12', cell: { row: 2, col: 2 }, anchor: { section: 0, paragraph: 11, part: 'table:0' } },
      ],
      note: '근거',
    });
  });

  it('find_text 일치를 그대로 highlight 대상으로 넘길 수 있다(누름틀 블록 포함)', async () => {
    const { matches } = matchesSchema.parse(await json('find_text', { query: '소강당' }));
    const targets = matches.map(({ before: _before, after: _after, ...target }) => target);

    expect(await json('highlight', { targets: [...targets, { id: 'b3' }] })).toEqual({ highlighted: 2, pages: [1] });
  });

  it('없는 블록 id 가 있으면 그 id 를 알려주고 아무것도 그리지 않는다', async () => {
    const text = await errorText('highlight', { targets: [{ id: 'b1' }, { id: 'b99' }, { id: 'b99' }] });

    expect(text).toBe('없는 블록 id 입니다: b99. get_outline 을 다시 불러 지금 블록 id 를 확인하세요.');
    expect(highlightRequests()).toHaveLength(0);
  });

  it('범위가 블록 글자 밖이면 블록 id·글자 수와 함께 오류를 돌려준다', async () => {
    expect(await errorText('highlight', { targets: [{ id: 'b1', start: 3, end: 40 }] })).toBe(
      'b1: 글자 범위가 맞지 않습니다(start 3, end 40, 글자 수 5). 0 ≤ start < end ≤ 글자 수로 주세요.',
    );
  });

  it('대상이 없거나 note 가 너무 길면 뷰어에 보내지 않고 오류다', async () => {
    expect((await call('highlight', { targets: [] })).isError).toBe(true);
    expect((await call('highlight', { targets: [{ id: 'b1' }], note: '가'.repeat(NOTE_MAX_CHARS + 1) })).isError).toBe(true);
    expect(highlightRequests()).toHaveLength(0);
  });

  it('note 가 공백뿐이면 note 없이 그린다', async () => {
    await json('highlight', { targets: [{ id: 'b1' }], note: '   ' });
    expect(highlightRequests().at(-1)?.params).not.toHaveProperty('note');
  });

  it('clear_highlight 는 뷰어의 하이라이트를 지우게 한다', async () => {
    expect(await json('clear_highlight')).toEqual({ cleared: true });
    expect(viewer.history.at(-1)?.method).toBe('clear_highlight');
  });

  it('뷰어가 연결되어 있지 않으면 정해진 오류 문구와 마지막 파일 경로를 돌려준다', async () => {
    const disconnected = once(bridge.events, 'disconnected');
    viewer.close();
    await disconnected;
    const expected = `뷰어가 연결되어 있지 않습니다. open_document 로 다시 여세요. 마지막 파일: ${fixturePath('notice.hwpx')}`;

    expect(await errorText('highlight', { targets: [{ id: 'b1' }] })).toBe(expected);
    expect(await errorText('clear_highlight')).toBe(expected);
  });
});
