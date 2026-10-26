import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Block } from '../src/core/block-schema.ts';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { createMcpServer } from '../src/server/mcp.ts';
import { DocumentSession } from '../src/server/session.ts';
import { textTargetSchema } from '../src/shared/protocol.ts';
import { FakeViewer } from './fake-viewer.ts';
import { fixturePath } from './fixtures.ts';
import { rhwpViewerHandler } from './rhwp-viewer.ts';

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});

const outlineSchema = z.object({
  blockCount: z.number(),
  blocks: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['paragraph', 'table', 'field']),
      page: z.number(),
      text: z.string(),
      number: z.string().optional(),
      outlineLevel: z.number().optional(),
      name: z.string().optional(),
    }),
  ),
  more: z.object({ message: z.string(), next: z.object({ from: z.string() }) }).optional(),
});

const cellSchema = z.object({ row: z.number(), col: z.number(), text: z.string(), rowLabel: z.string() });
const readSchema = z.object({
  blocks: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      page: z.number(),
      text: z.string().optional(),
      cells: z.array(cellSchema).optional(),
      truncated: z.literal(true).optional(),
    }),
  ),
  more: z.object({ message: z.string(), next: z.record(z.string(), z.unknown()).optional() }).optional(),
});

const findSchema = z.object({
  query: z.string(),
  matchCount: z.number(),
  matches: z.array(
    z.object({
      id: z.string(),
      cell: z.object({ row: z.number(), col: z.number() }).optional(),
      start: z.number(),
      end: z.number(),
      before: z.string(),
      after: z.string(),
    }),
  ),
});

const NOT_CONNECTED = '뷰어가 연결되어 있지 않습니다. open_document 로 다시 여세요.';

describe('SPEC-001 문서 구조 읽기 도구 (get_outline · read_blocks · find_text)', () => {
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

  beforeEach(async () => {
    bridge = await startBridge({ port: 0, viewerDir: tmpdir() });
    session = new DocumentSession(bridge, { openBrowser: vi.fn() });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(session).connect(serverSide);
    client = new Client({ name: 'docbridge-test', version: '0.0.0' });
    await client.connect(clientSide);
    viewer = await FakeViewer.connect(bridge.viewerUrl);
  });

  afterEach(async () => {
    viewer.close();
    await client.close();
    await bridge.close();
  });

  /** rhwp 로 실제 fixture 를 여는 뷰어 */
  const openWithRhwp = async (fixture: string) => {
    viewer.serve(rhwpViewerHandler());
    await json('open_document', { path: fixturePath(fixture) });
  };

  /** 문단 n 개짜리 큰 문서를 연 것처럼 답하는 뷰어 */
  const openLargeDocument = async (count: number, text: string) => {
    const blocks: Block[] = Array.from({ length: count }, (_, i) => ({
      kind: 'paragraph',
      section: 0,
      paragraph: i,
      page: Math.floor(i / 40) + 1,
      text,
    }));
    viewer.serve((request) => {
      switch (request.method) {
        case 'load_document':
          return { pageCount: Math.ceil(count / 40), blocks: blocks.map(({ kind, section, paragraph }) => ({ kind, section, paragraph })) };
        case 'get_blocks':
          return blocks;
        case 'find_text':
          return [];
      }
    });
    await json('open_document', { path: fixturePath('notice.hwpx') });
  };

  it('get_outline 은 본문 문단·표·누름틀을 문서 순서대로 id·kind·쪽·앞 40자와 함께 돌려주고, 자동 번호 문단은 번호 문자열을 포함한다', async () => {
    await openWithRhwp('notice.hwpx');

    const result = outlineSchema.parse(await json('get_outline'));

    expect(result.blockCount).toBe(14);
    expect(result.blocks.map((b) => b.id)).toEqual(Array.from({ length: 14 }, (_, i) => `b${i + 1}`));
    expect(result.blocks.map((b) => b.kind)).toEqual([
      'paragraph', 'paragraph', 'field', 'paragraph', 'paragraph',
      'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph',
      'table', 'paragraph', 'paragraph',
    ]);
    expect(result.blocks.every((b) => b.page === 1 && [...b.text].length <= 41)).toBe(true);
    expect(result.blocks.flatMap((b) => (b.number === undefined ? [] : [b.number]))).toEqual(['1.', '2.', '가.', '나.', '다.', '3.']);
    expect(result.blocks.find((b) => b.kind === 'field')).toMatchObject({ name: '수신' });
  });

  it('get_outline 은 개요 문단의 개요 수준을 준다', async () => {
    await openWithRhwp('outline-demo.hwpx');

    const result = outlineSchema.parse(await json('get_outline'));

    expect(result.blocks.find((b) => b.number === '가.')).toMatchObject({ outlineLevel: 2 });
  });

  it('read_blocks 는 표 블록에 대해 칸마다 행,열·텍스트·같은 행 첫 칸 텍스트를 돌려준다', async () => {
    await openWithRhwp('notice.hwpx');
    const table = outlineSchema.parse(await json('get_outline')).blocks.find((b) => b.kind === 'table');

    const result = readSchema.parse(await json('read_blocks', { ids: [table?.id] }));

    const cells = result.blocks[0]?.cells ?? [];
    expect(cells).toHaveLength(9);
    expect(cells).toContainEqual({ row: 2, col: 2, text: '구민회관 소강당', rowLabel: '2회차' });
    expect(cells.filter((c) => c.row === 1).every((c) => c.rowLabel === '1회차')).toBe(true);
  });

  it('read_blocks 는 쪽 범위로 고른 블록의 전문을 돌려준다', async () => {
    await openWithRhwp('notice.hwpx');

    const result = readSchema.parse(await json('read_blocks', { fromPage: 1 }));

    expect(result.blocks).toHaveLength(14);
    expect(result.blocks.find((b) => b.id === 'b7')?.text).toBe(
      '하반기 주민 안전교육을 아래와 같이 실시하오니 각 동 주민센터에서는 주민들이 참여할 수 있도록 안내하여 주시기 바랍니다.',
    );
  });

  it('read_blocks 에 없는 블록 id 를 주면 그 id 를 알려주고 get_outline 을 다시 부르라고 안내한다', async () => {
    await openWithRhwp('notice.hwpx');

    const result = await call('read_blocks', { ids: ['b1', 'b999'] });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('없는 블록 id 입니다: b999. get_outline 을 다시 불러 지금 블록 id 를 확인하세요.');
  });

  it('read_blocks 는 ids 나 쪽 범위 중 하나로만 고르게 한다', async () => {
    await openWithRhwp('notice.hwpx');

    expect((await call('read_blocks', {})).content[0]?.text).toBe('읽을 블록을 ids 나 fromPage(·toPage) 로 정하세요.');
    expect((await call('read_blocks', { ids: ['b1'], fromPage: 1 })).content[0]?.text).toBe(
      'ids 와 쪽 범위(fromPage·toPage) 중 하나만 주세요.',
    );
  });

  it('read_blocks 는 문서 밖·거꾸로 된 쪽 범위와 ids+from 을 빈 결과 대신 오류로 거부한다', async () => {
    await openWithRhwp('notice.hwpx');

    const rejected = async (args: Record<string, unknown>) => {
      const result = await call('read_blocks', args);
      expect(result.isError).toBe(true);
      return result.content[0]?.text;
    };

    expect(await rejected({ fromPage: 0 })).toBe('쪽 번호는 1부터입니다(fromPage: 0).');
    expect(await rejected({ fromPage: 2 })).toBe('이 문서는 1쪽까지입니다(fromPage: 2).');
    expect(await rejected({ fromPage: 1, toPage: 0 })).toBe('쪽 번호는 1부터입니다(toPage: 0).');
    expect(await rejected({ ids: ['b1'], from: 'b2' })).toMatch(/^from 은 쪽 범위/);
  });

  it('find_text 는 일치하는 모든 위치의 블록 id·범위·앞뒤 20자를 돌려준다(표 칸 안은 칸 좌표까지)', async () => {
    await openWithRhwp('notice.hwpx');
    const outline = outlineSchema.parse(await json('get_outline'));
    const tableId = outline.blocks.find((b) => b.kind === 'table')?.id;

    const result = findSchema.parse(await json('find_text', { query: '주민' }));
    const cell = findSchema.parse(await json('find_text', { query: '소강당' }));

    expect(result.matchCount).toBeGreaterThan(1);
    expect(result.matchCount).toBe(result.matches.length);
    const read = readSchema.parse(await json('read_blocks', { ids: result.matches.map((m) => m.id) }));
    for (const match of result.matches) {
      const text = read.blocks.find((b) => b.id === match.id)?.text ?? '';
      expect(text.slice(match.start, match.end)).toBe('주민');
      expect(match.before).toBe(text.slice(Math.max(0, match.start - 20), match.start));
      expect(match.after).toBe(text.slice(match.end, match.end + 20));
    }
    expect(cell.matches).toEqual([{ id: tableId, cell: { row: 2, col: 2 }, start: 5, end: 8, before: '구민회관 ', after: '' }]);
  });

  it('find_text 일치에서 앞뒤 문맥을 뺀 id·cell·start·end 는 하이라이트 대상(TextTarget) 형식 그대로다', async () => {
    await openWithRhwp('notice.hwpx');

    const found = findSchema.parse(await json('find_text', { query: '구민회관' }));

    expect(found.matchCount).toBeGreaterThan(0);
    for (const { before: _before, after: _after, ...target } of found.matches) {
      expect(textTargetSchema.parse(target)).toEqual(target);
    }
  });

  it('get_outline 결과가 500블록을 넘으면 잘라서 돌려주고 from 으로 이어 받는 방법을 알려준다', async () => {
    await openLargeDocument(620, '문단');

    const first = outlineSchema.parse(await json('get_outline'));
    const rest = outlineSchema.parse(await json('get_outline', { from: first.more?.next.from }));

    expect(first.blockCount).toBe(620);
    expect(first.blocks).toHaveLength(500);
    expect(first.more?.message).toBe('블록이 620개라 1~500번째만 보냈습니다. 나머지는 get_outline 을 from: "b501" 로 다시 부르세요.');
    expect(rest.blocks.map((b) => b.id)).toEqual(Array.from({ length: 120 }, (_, i) => `b${501 + i}`));
    expect(rest.more).toBeUndefined();
  });

  it('read_blocks 결과가 20,000자를 넘으면 잘라서 돌려주고 more.next 로 이어 받는 방법을 알려준다', async () => {
    await openLargeDocument(50, '가'.repeat(1_000));

    const first = readSchema.parse(await json('read_blocks', { fromPage: 1, toPage: 2 }));
    const rest = readSchema.parse(await json('read_blocks', first.more?.next));

    expect(first.blocks).toHaveLength(20);
    expect(first.more).toEqual({
      message: '글자가 20,000자를 넘어 블록 50개 중 20개만 보냈습니다. 나머지는 read_blocks 를 more.next 의 인자로 다시 부르세요.',
      next: { fromPage: 1, toPage: 2, from: 'b21' },
    });
    expect(rest.blocks.map((b) => b.id)).toEqual(Array.from({ length: 20 }, (_, i) => `b${21 + i}`));
  });

  it('뷰어가 연결되어 있지 않으면 읽기 도구도 정해진 오류 문구와 마지막 파일 경로를 돌려준다', async () => {
    await openWithRhwp('notice.hwpx');
    const disconnected = once(bridge.events, 'disconnected');
    viewer.close();
    await disconnected;

    for (const [name, args] of [
      ['get_outline', {}],
      ['read_blocks', { ids: ['b1'] }],
      ['find_text', { query: '주민' }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toBe(`${NOT_CONNECTED} 마지막 파일: ${fixturePath('notice.hwpx')}`);
    }
  });
});
