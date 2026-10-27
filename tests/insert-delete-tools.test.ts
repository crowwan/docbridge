// SPEC-002 문단 넣기·지우기 도구(#20): MCP 도구 → 편집 공용 경로 → rhwp 테스트 뷰어. id 표가 편집에 맞춰 옮겨지는지 본다.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { createMcpServer } from '../src/server/mcp.ts';
import { DocumentSession } from '../src/server/session.ts';
import type { RequestMessage } from '../src/shared/protocol.ts';
import { FakeViewer } from './fake-viewer.ts';
import { fixturePath, openFixture } from './fixtures.ts';
import { rhwpViewer, type RhwpViewer } from './rhwp-viewer.ts';

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});

const outlineSchema = z.object({
  blocks: z.array(z.object({ id: z.string(), kind: z.string(), text: z.string(), number: z.string().optional() })),
});

describe('SPEC-002 문단 넣기·지우기 도구 (insert_paragraph · delete_blocks)', () => {
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
  /** get_outline 의 id → "종류:앞 40자" */
  const outline = async () =>
    new Map(outlineSchema.parse(await json('get_outline')).blocks.map(({ id, kind, text }) => [id, `${kind}:${text}`]));
  /** 편집 전 블록이 편집 뒤에도 같은 id 로 같은 내용인지(빠진 id 는 except) */
  const expectIdsKept = (before: Map<string, string>, after: Map<string, string>, except: string[] = []) => {
    for (const [id, text] of before) {
      if (!except.includes(id)) expect(after.get(id), id).toBe(text);
    }
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

  it('AC-2 insert_paragraph 는 기준 블록 뒤에 새 문단을 넣고 새 블록 id 를 준다. 기존 블록 id 는 같은 블록을 가리킨다', async () => {
    const before = await outline();

    const result = await json('insert_paragraph', { after: 'b11', text: '문의: 안전총괄과(02-123-4567)' });

    expect(result).toEqual({ inserted: 'b15', changed: [{ id: 'b15', text: '문의: 안전총괄과(02-123-4567)' }] });
    const after = await outline();
    expect(after.get('b15')).toBe('paragraph:문의: 안전총괄과(02-123-4567)');
    expectIdsKept(before, after);
    expect([...after.keys()].slice(10, 13)).toEqual(['b11', 'b15', 'b12']);
  });

  it('AC-2 번호 문단 앞에 넣으면 새 문단이 번호를 받고, 뒤 블록 id 는 다시 매겨진 번호와 함께 그대로다', async () => {
    const result = await json('insert_paragraph', { before: 'b6', text: '새로 넣은 항목' });

    expect(result).toMatchObject({ inserted: 'b15' });
    const numbers = new Map(outlineSchema.parse(await json('get_outline')).blocks.map(({ id, number }) => [id, number]));
    expect([numbers.get('b15'), numbers.get('b6'), numbers.get('b7')]).toEqual(['1.', '2.', '3.']);
  });

  it('AC-2 넣은 뒤 다시 넣고 지워도 id 가 같은 블록을 가리키고, 되돌리면 넣은 id 가 사라진다', async () => {
    const before = await outline();
    await json('insert_paragraph', { after: 'b12', text: '표 뒤 문단' });
    await json('insert_paragraph', { before: 'b15', text: '표 바로 뒤 문단' });
    expect(await json('read_blocks', { ids: ['b15', 'b16'] })).toMatchObject({
      blocks: [{ id: 'b15', text: '표 뒤 문단' }, { id: 'b16', text: '표 바로 뒤 문단' }],
    });

    expect(await json('undo', { steps: 2 })).toEqual({ undone: 2, edits: ['insert_paragraph before b15', 'insert_paragraph after b12'] });
    const after = await outline();
    expect(after).toEqual(before);
  });

  it('before·after 를 둘 다 주거나 하나도 안 주면, 없는 id 면 뷰어에 보내지 않고 오류다', async () => {
    expect(await errorText('insert_paragraph', { before: 'b5', after: 'b6', text: 'X' })).toBe('before 와 after 중 하나만 주세요.');
    expect(await errorText('insert_paragraph', { text: 'X' })).toBe('before 와 after 중 하나만 주세요.');
    expect(await errorText('insert_paragraph', { after: 'b99', text: 'X' })).toBe(
      '없는 블록 id 입니다: b99. get_outline 을 다시 불러 지금 블록 id 를 확인하세요.',
    );
    expect(requests('edit')).toHaveLength(0);
  });

  it('줄바꿈이 든 글자·구역 첫 문단 앞 넣기는 뷰어가 거부하고 편집 기록·id 표는 그대로다', async () => {
    expect(await errorText('insert_paragraph', { after: 'b5', text: '첫 줄\n둘째 줄' })).toBe(
      '넣을 글자에 줄바꿈이 있습니다. 문단을 여럿 넣으려면 insert_paragraph 를 문단마다 부르세요.',
    );
    expect(await errorText('insert_paragraph', { before: 'b1', text: '맨 앞' })).toBe(
      '구역 첫 문단 앞에는 문단을 넣을 수 없습니다. 첫 문단 뒤에 넣으세요.',
    );
    expect(session.editCount).toBe(0);
    expect(session.document?.ids.anchor('b15')).toBeUndefined();
  });

  it('AC-3 delete_blocks 는 문단 여러 개를 한 편집으로 지우고 나머지 id 는 같은 블록을 가리킨다. undo 한 번에 모두 돌아온다', async () => {
    const before = await outline();

    expect(await json('delete_blocks', { ids: ['b10', 'b8'] })).toEqual({ deleted: ['b8', 'b10'] });

    const after = await outline();
    expect([after.has('b8'), after.has('b10')]).toEqual([false, false]);
    expectIdsKept(before, after, ['b8', 'b10']);
    expect(await json('undo')).toEqual({ undone: 1, edits: ['delete_blocks b10, b8'] });
    expect(await outline()).toEqual(before);
  });

  it('AC-3 표를 지우고 나머지 id 는 같은 블록을 가리킨다. 문단 블록을 지우면 든 누름틀 id 도 지운 id 로 알린다', async () => {
    const before = await outline();

    expect(await json('delete_blocks', { ids: ['b12'] })).toEqual({ deleted: ['b12'] });
    expect(await json('delete_blocks', { ids: ['b2'] })).toEqual({ deleted: ['b2', 'b3'] });

    const after = await outline();
    expectIdsKept(before, after, ['b2', 'b3', 'b12']);
    expect([...after.keys()]).toEqual(['b1', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10', 'b11', 'b13', 'b14']);
  });

  it('AC-3 글자가 있는 문단의 표만 지우면 표 id 만 사라지고 문단 id 는 그 글자를 가리킨다', async () => {
    const doc = openFixture('notice.hwpx');
    doc.insertText(0, 11, doc.getParagraphLength(0, 11), '표 아래 설명');
    const path = join(await mkdtemp(join(tmpdir(), 'docbridge-delete-')), '표와 글자.hwpx');
    await writeFile(path, doc.exportHwpx());
    await json('open_document', { path });
    const before = await outline();
    expect([before.get('b12'), before.get('b13')]).toEqual(['paragraph:표 아래 설명', expect.stringMatching(/^table:/)]);

    expect(await json('delete_blocks', { ids: ['b13'] })).toEqual({ deleted: ['b13'] });

    const after = await outline();
    expectIdsKept(before, after, ['b13']);
    expect(after.has('b13')).toBe(false);
    // 지운 표 id 는 id 표에서도 사라져 다시 쓰이지 않는다
    expect(session.document?.ids.anchor('b13')).toBeUndefined();
  });

  it('AC-3 누름틀 블록과 구역 첫 문단(구역을 비우는 삭제)은 뷰어에 보내지 않고 거부한다', async () => {
    expect(await errorText('delete_blocks', { ids: ['b3'] })).toBe(
      '누름틀 블록은 지울 수 없습니다: b3. 값을 비우려면 replace_text 를, 문단째 지우려면 그 문단 블록 id 를 주세요.',
    );
    const everything = [...(await outline()).keys()].filter((id) => id !== 'b3');
    expect(await errorText('delete_blocks', { ids: everything })).toBe(
      '구역 첫 문단은 지울 수 없습니다(구역·단 정의가 든 문단): b1. 글자를 지우려면 replace_text 를 쓰세요.',
    );
    expect(await errorText('delete_blocks', { ids: ['b5', 'b99'] })).toBe(
      '없는 블록 id 입니다: b99. get_outline 을 다시 불러 지금 블록 id 를 확인하세요.',
    );
    expect(requests('edit')).toHaveLength(0);
    expect(session.editCount).toBe(0);
  });

  it('서버는 뷰어가 실제로 지운 문단·넣은 자리로 id 표를 옮긴다 — 서버 생각과 달라도 id 가 엉뚱한 블록을 가리키지 않는다 (PR #29 리뷰)', async () => {
    const before = await outline();
    const b8 = session.document?.ids.anchor('b8');
    const b10 = session.document?.ids.anchor('b10');
    const b6 = session.document?.ids.anchor('b6');
    if (b8 === undefined || b10 === undefined || b6 === undefined) throw new Error('블록이 없다');
    // 어긋남 흉내: 뷰어가 받은 대상과 다른 블록(b8 대신 b10, b11 뒤 대신 b6 앞)에 편집을 적용한다
    viewer.serve((request) => {
      if (request.method !== 'edit') return rhwp.handle(request);
      const { operation } = request.params;
      if (operation.kind === 'delete_blocks') {
        return rhwp.handle({ ...request, params: { ...request.params, operation: { ...operation, targets: [{ id: 'b10', anchor: b10 }] } } });
      }
      if (operation.kind === 'insert_paragraph') {
        const moved = { ...operation, reference: { id: 'b6', anchor: b6 }, where: 'before' as const };
        return rhwp.handle({ ...request, params: { ...request.params, operation: moved } });
      }
      return rhwp.handle(request);
    });

    expect(await json('delete_blocks', { ids: ['b8'] })).toEqual({ deleted: ['b10'] });
    expect(await json('insert_paragraph', { after: 'b11', text: '넣은 문단' })).toMatchObject({ inserted: 'b15' });

    const after = await outline();
    expectIdsKept(before, after, ['b10']);
    expect(after.get('b15')).toBe('paragraph:넣은 문단');
    expect([...after.keys()].slice(4, 7)).toEqual(['b5', 'b15', 'b6']);
  });

  it('넣고 지운 뒤 글자를 바꿔도 id 표 위치로 맞는 블록을 고친다', async () => {
    await json('insert_paragraph', { after: 'b1', text: '넣은 문단' });
    await json('delete_blocks', { ids: ['b4'] });

    await json('replace_text', { target: { id: 'b11' }, text: '회신 기한: 11. 7.까지' });

    expect(await json('read_blocks', { ids: ['b15', 'b11', 'b12'] })).toMatchObject({
      blocks: [{ id: 'b15', text: '넣은 문단' }, { id: 'b11', text: '회신 기한: 11. 7.까지' }, { id: 'b12', kind: 'table' }],
    });
    expect(rhwp.editor().depth).toBe(3);
  });
});
