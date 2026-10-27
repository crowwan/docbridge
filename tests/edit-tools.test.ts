import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { UNDO_LIMIT } from '../src/core/edit-history.ts';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { createMcpServer } from '../src/server/mcp.ts';
import { DocumentSession } from '../src/server/session.ts';
import { REQUEST_TIMEOUT_MS, type RequestMessage } from '../src/shared/protocol.ts';
import { replaceText } from '../src/server/edit-tools.ts';
import { FakeViewer, NO_RESPONSE } from './fake-viewer.ts';
import { fixturePath } from './fixtures.ts';
import { rhwpViewer, type RhwpViewer } from './rhwp-viewer.ts';

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});

describe('SPEC-002 글자 바꾸기·되돌리기 도구 (replace_text · undo)', () => {
  let bridge: Bridge;
  let session: DocumentSession;
  let client: Client;
  let viewer: FakeViewer;
  let rhwp: RhwpViewer;

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
  const requests = (method: RequestMessage['method']) => viewer.history.filter((request) => request.method === method);
  /** read_blocks 로 읽은 블록 하나의 글자(문단 text, 누름틀 value) */
  const readText = async (id: string) => {
    const { blocks } = z
      .object({ blocks: z.array(z.object({ text: z.string().optional(), value: z.string().optional() })) })
      .parse(await json('read_blocks', { ids: [id] }));
    return blocks[0]?.text ?? blocks[0]?.value;
  };

  beforeEach(async () => {
    bridge = await startBridge({ port: 0, viewerDir: tmpdir() });
    session = new DocumentSession(bridge, { openBrowser: vi.fn() });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(session).connect(serverSide);
    client = new Client({ name: 'docbridge-test', version: '0.0.0' });
    await client.connect(clientSide);
    viewer = await FakeViewer.connect(bridge.viewerUrl);
    rhwp = rhwpViewer();
    viewer.serve(rhwp.handle);
    await json('open_document', { path: fixturePath('notice.hwpx') });
  });

  afterEach(async () => {
    viewer.close();
    await client.close();
    await bridge.close();
  });

  it('AC-1 replace_text 는 find_text 로 찾은 문단 일부를 바꾸고 바뀐 블록 id 와 바뀐 뒤 앞 40자를 돌려준다', async () => {
    const { matches } = z
      .object({ matches: z.array(z.object({ id: z.string(), start: z.number(), end: z.number() })) })
      .parse(await json('find_text', { query: '11. 14.' }));
    const [match] = matches;

    const result = await json('replace_text', { target: match, text: '11. 7.' });

    expect(result).toEqual({ changed: [{ id: 'b11', text: '회신 기한: 2026. 11. 7.(금)까지 참석 인원을 회신하여 주시기…' }] });
    expect(await readText('b11')).toBe('회신 기한: 2026. 11. 7.(금)까지 참석 인원을 회신하여 주시기 바랍니다.');
    expect(requests('edit').at(-1)?.params).toEqual({
      operation: {
        kind: 'replace_text',
        target: { id: 'b11', start: 13, end: 20, anchor: { section: 0, paragraph: 10, part: 'text' } },
        text: '11. 7.',
      },
      depth: 0,
    });
  });

  it('AC-1 표 칸과 누름틀 값을 바꾸면 칸 글자·누름틀 값이 바뀌고, 칸이면 결과에 칸과 칸 글자를 준다', async () => {
    expect(await json('replace_text', { target: { id: 'b12', cell: { row: 2, col: 2 } }, text: '구민회관 3층 강당' })).toEqual({
      changed: [{ id: 'b12', cell: { row: 2, col: 2 }, text: '구민회관 3층 강당' }],
    });
    expect(await json('replace_text', { target: { id: 'b3' }, text: '각 동 주민센터' })).toMatchObject({
      changed: [{ id: 'b2' }, { id: 'b3', text: '각 동 주민센터' }],
    });
    expect(await readText('b3')).toBe('각 동 주민센터');
  });

  it('줄바꿈이 든 글자·범위 오류는 뷰어가 이유를 돌려주고 편집 기록에 남지 않는다', async () => {
    expect(await errorText('replace_text', { target: { id: 'b1' }, text: '첫 줄\n둘째 줄' })).toBe(
      '바꿀 글자에 줄바꿈이 있습니다. 새 문단은 insert_paragraph 로 넣으세요.',
    );
    expect(await errorText('replace_text', { target: { id: 'b1', start: 2, end: 30 }, text: 'X' })).toBe(
      'b1: 글자 범위가 맞지 않습니다(start 2, end 30, 글자 수 5). 0 ≤ start ≤ end ≤ 글자 수로 주세요.',
    );
    expect([session.editCount, session.dirty]).toEqual([0, false]);
    expect(await errorText('undo')).toBe('되돌릴 편집이 없습니다.');
  });

  it('없는 블록 id 면 뷰어에 보내지 않고 오류다', async () => {
    expect(await errorText('replace_text', { target: { id: 'b99' }, text: 'X' })).toBe(
      '없는 블록 id 입니다: b99. get_outline 을 다시 불러 지금 블록 id 를 확인하세요.',
    );
    expect(requests('edit')).toHaveLength(0);
  });

  it('AC-8 undo 는 편집을 하나씩 되돌리고 되돌린 편집을 알려준다. 되돌릴 것이 없으면 정해진 문구다', async () => {
    await json('replace_text', { target: { id: 'b1' }, text: '라마바구청' });
    await json('replace_text', { target: { id: 'b12', cell: { row: 1, col: 0 } }, text: '첫 회' });

    expect(await json('undo')).toEqual({ undone: 1, edits: ['replace_text b12 칸(1,0)'] });
    expect(await json('undo', { steps: 1 })).toEqual({ undone: 1, edits: ['replace_text b1'] });
    expect(await readText('b1')).toBe('가나다구청');
    expect(await errorText('undo')).toBe('되돌릴 편집이 없습니다.');
  });

  it('AC-8 있는 것보다 많이 되돌리라고 하면 있는 만큼 되돌리고 알린다. 한 번에 20단계를 넘게는 받지 않는다', async () => {
    await json('replace_text', { target: { id: 'b1' }, text: '라마바구청' });
    await json('replace_text', { target: { id: 'b1' }, text: '사아자구청' });

    expect(await json('undo', { steps: 5 })).toEqual({
      undone: 2,
      edits: ['replace_text b1', 'replace_text b1'],
      warnings: [`되돌릴 수 있는 편집이 2개뿐이라(최대 ${UNDO_LIMIT}단계) 2개를 되돌렸습니다.`],
    });
    expect((await call('undo', { steps: UNDO_LIMIT + 1 })).isError).toBe(true);
  });

  it('AC-8 되돌리면 블록 id 표도 그 편집 전 상태로 돌아간다', async () => {
    // 문단을 넣는 편집(#20)처럼 id 표를 옮기는 편집을 공용 경로로 흉내 낸다: 글자는 바꾸고 id 표는 문단 하나를 민다
    await session.edit(
      'id 표를 옮기는 편집',
      (document) => {
        const anchor = document.ids.anchor('b1');
        if (anchor === undefined) throw new Error('b1 이 없다');
        return { kind: 'replace_text', target: { id: 'b1', anchor }, text: '라마바구청' };
      },
      (ids) => void ids.paragraphInserted(0, 1),
    );
    expect(session.document?.ids.anchor('b2')).toEqual({ section: 0, paragraph: 2, part: 'text' });

    await json('undo');

    expect(session.document?.ids.anchor('b2')).toEqual({ section: 0, paragraph: 1, part: 'text' });
    expect(session.document?.ids.anchor('b15')).toBeUndefined();
    expect(await readText('b2')).toBe('수신  ');
  });

  it('AC-7 편집하면 뷰어가 다시 그린 쪽 수를 서버가 받아 두고, 편집이 끝나야 다음 요청이 간다', async () => {
    // 긴 글자로 바꿔 쪽이 늘게 한다
    const edit = json('replace_text', { target: { id: 'b7' }, text: '가나다 '.repeat(900) });
    const read = json('get_outline');
    await Promise.all([edit, read]);

    expect(viewer.history.map((request) => request.method).slice(-2)).toEqual(['edit', 'get_blocks']);
    expect(session.document?.pageCount).toBeGreaterThan(1);
    expect(session.document?.pageCount).toBe(rhwp.editor().doc.pageCount());
    await json('undo');
    expect(session.document?.pageCount).toBe(1);
  });

  it('AC-12 저장하지 않은 편집이 있는 채로 새 문서를 열면 버린 편집 수를 알린다', async () => {
    await json('replace_text', { target: { id: 'b1' }, text: '라마바구청' });
    await json('replace_text', { target: { id: 'b3' }, text: '각 동 주민센터' });
    await json('undo');

    expect(await json('open_document', { path: fixturePath('report.hwpx') })).toMatchObject({
      fileName: 'report.hwpx',
      warnings: ['저장하지 않은 편집 1개를 버렸습니다'],
    });
    expect(session.unsavedEdits).toBe(0);
  });

  it('뷰어가 편집을 적용했는데 결과를 읽지 못하면, 다음 편집·되돌리기는 기록이 어긋났다고 알리고 아무것도 바꾸지 않는다 (PR #26 리뷰)', async () => {
    viewer.serve((request) => {
      const result = rhwp.handle(request);
      // 편집은 적용하고 서버가 읽지 못하는 결과를 돌려준다
      return request.method === 'edit' ? { 엉뚱한: true } : result;
    });
    expect(await errorText('replace_text', { target: { id: 'b1' }, text: '라마바구청' })).toContain('뷰어 응답을 읽지 못했습니다(edit)');
    viewer.serve(rhwp.handle);
    const blocksBefore = JSON.stringify(rhwp.editor().blocks);

    const mismatch = '편집 기록이 어긋났습니다(서버 0, 뷰어 1). open_document 로 문서를 다시 열어 주세요.';
    expect(await errorText('replace_text', { target: { id: 'b3' }, text: '각 동' })).toBe(mismatch);
    // 서버 기록에는 되돌릴 편집이 없다 → 뷰어에 묻지 않는다. 뷰어 문서는 그대로
    expect(await errorText('undo')).toBe('되돌릴 편집이 없습니다.');
    expect(JSON.stringify(rhwp.editor().blocks)).toBe(blocksBefore);
  });

  it('편집 요청이 타임아웃돼도(뷰어는 적용함) 다음 편집에서 기록이 어긋났다고 알린다 (PR #26 리뷰)', async () => {
    let reached: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    viewer.serve((request) => {
      const result = rhwp.handle(request);
      if (request.method !== 'edit') return result;
      reached();
      return NO_RESPONSE;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const first = replaceText(session, { id: 'b1' }, '라마바구청').then(
        () => '성공',
        (error: unknown) => String(error),
      );
      await arrived;
      vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
      expect(await first).toContain('응답하지 않았습니다(edit)');
    } finally {
      vi.useRealTimers();
    }
    viewer.serve(rhwp.handle);

    expect(await errorText('replace_text', { target: { id: 'b1' }, text: '사아자구청' })).toBe(
      '편집 기록이 어긋났습니다(서버 0, 뷰어 1). open_document 로 문서를 다시 열어 주세요.',
    );
    expect(await readText('b1')).toBe('라마바구청');
  });

  it('누름틀 값을 바꾸면 같은 문단 블록도 바뀐 블록으로 돌려주고, 비운 문단은 같은 id 로 다시 채울 수 있다 (PR #26 리뷰)', async () => {
    expect(await json('replace_text', { target: { id: 'b3' }, text: '각 동 주민센터' })).toEqual({
      changed: [
        { id: 'b2', text: '수신  각 동 주민센터' },
        { id: 'b3', text: '각 동 주민센터' },
      ],
    });
    expect(await json('replace_text', { target: { id: 'b5' }, text: '' })).toEqual({
      changed: [{ id: 'b5', text: '' }],
      warnings: ['b5: 화면에 표시할 자리가 없어(빈 문단 등) 바뀐 블록 표시를 하지 못했습니다.'],
    });
    await json('replace_text', { target: { id: 'b5' }, text: '새 제목' });
    expect(await readText('b5')).toBe('새 제목');
  });

  it('뷰어가 연결되어 있지 않으면 정해진 오류 문구와 마지막 파일 경로를 돌려준다', async () => {
    const disconnected = once(bridge.events, 'disconnected');
    viewer.close();
    await disconnected;
    const expected = `뷰어가 연결되어 있지 않습니다. open_document 로 다시 여세요. 마지막 파일: ${fixturePath('notice.hwpx')}`;

    expect(await errorText('replace_text', { target: { id: 'b1' }, text: 'X' })).toBe(expected);
    expect(await errorText('undo')).toBe(expected);
  });
});
