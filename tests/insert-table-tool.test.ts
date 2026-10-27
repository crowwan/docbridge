// SPEC-003 표 만들기 도구(#38): MCP 도구 → 편집 공용 경로 → rhwp 테스트 뷰어. "문단 넣기 + 표 넣기" 한 편집과 id 표를 본다.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { isHeaderCell } from '../src/core/create-document.ts';
import { parseJson } from '../src/core/json.ts';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { createMcpServer } from '../src/server/mcp.ts';
import { DocumentSession } from '../src/server/session.ts';
import type { RequestMessage } from '../src/shared/protocol.ts';
import { FakeViewer } from './fake-viewer.ts';
import { fixturePath } from './fixtures.ts';
import { rhwpViewer, type RhwpViewer } from './rhwp-viewer.ts';

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});
const outlineSchema = z.object({
  blocks: z.array(z.object({ id: z.string(), kind: z.string(), text: z.string(), number: z.string().optional() })),
});
const tableBlocksSchema = z.object({
  blocks: z.array(
    z.object({
      id: z.string(),
      kind: z.literal('table'),
      rowCount: z.number(),
      colCount: z.number(),
      cells: z.array(z.object({ row: z.number(), col: z.number(), text: z.string() })),
    }),
  ),
});
const tablePropsSchema = z.looseObject({ repeatHeader: z.boolean() });
const charPropsSchema = z.looseObject({ bold: z.boolean() });
const cellWidthSchema = z.looseObject({ width: z.number() });

describe('SPEC-003 표 만들기 (insert_table)', () => {
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
  const outlineBlocks = async () => outlineSchema.parse(await json('get_outline')).blocks;
  /** get_outline 의 id → "종류:번호 앞 40자" */
  const outline = async () =>
    new Map((await outlineBlocks()).map(({ id, kind, text, number }) => [id, `${kind}:${number ?? ''} ${text}`]));
  const readTable = async (id: string) => tableBlocksSchema.parse(await json('read_blocks', { ids: [id] })).blocks[0];
  /** 테스트 뷰어 문서에서 블록 id 의 표 주소 */
  const tableAddress = (id: string) => {
    const anchor = session.document?.ids.anchor(id);
    const match = /^table:(\d+)$/.exec(anchor?.part ?? '');
    if (anchor === undefined || match?.[1] === undefined) throw new Error(`${id} 는 표가 아닙니다`);
    return { section: anchor.section, paragraph: anchor.paragraph, controlIndex: Number(match[1]) };
  };

  const openDocument = (name: string) => json('open_document', { path: fixturePath(name) });

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
  });

  afterEach(async () => {
    viewer.close();
    await client.close();
    await bridge.close();
  });

  it('AC-6 기준 블록 뒤에 rows×cols 표를 만들고 cells 글자를 채우며 새 표 블록 id 와 칸 수를 준다. 기존 블록 id 는 그대로다', async () => {
    await openDocument('notice.hwpx');
    const before = await outline();

    const result = await json('insert_table', {
      after: 'b5',
      rows: 2,
      cols: 3,
      cells: [
        ['구분', '일정', '장소'],
        ['1회차', '11. 20.', '대강당'],
      ],
    });

    expect(result).toEqual({ inserted: 'b15', cells: 6, changed: [{ id: 'b15', text: '구분 | 일정 | 장소 | 1회차 | 11. 20. | 대강당' }] });
    const after = await outline();
    for (const [id, text] of before) expect(after.get(id), id).toBe(text);
    // 새로 생긴 블록은 표 하나다(표가 든 문단은 글자가 없어 문단 블록이 아니다)
    expect([...after.keys()].slice(4, 7)).toEqual(['b5', 'b15', 'b6']);
    expect(after.size).toBe(before.size + 1);
    // 뷰어 블록에도 표 문단의 빈 문단 블록이 없다(있으면 서버 id 표에 없는 블록이 되어 move_blocks 가 그 범위를 거부한다)
    expect(rhwp.editor().blocks).toHaveLength(after.size);
    expect(await readTable('b15')).toMatchObject({ rowCount: 2, colCount: 3 });
    expect((await readTable('b15'))?.cells.map(({ text }) => text)).toEqual(['구분', '일정', '장소', '1회차', '11. 20.', '대강당']);
  });

  it('AC-6 cells 없이 만들면 빈 칸 표이고, 열 너비는 쪽 본문 너비를 열 수로 똑같이 나눈다', async () => {
    await openDocument('notice.hwpx');

    expect(await json('insert_table', { after: 'b13', rows: 1, cols: 2 })).toMatchObject({ inserted: 'b15', cells: 2 });

    expect((await readTable('b15'))?.cells.map(({ text }) => text)).toEqual(['', '']);
    const { section, paragraph, controlIndex } = tableAddress('b15');
    const doc = rhwp.editor().doc;
    const widths = [0, 1].map(
      (cell) => parseJson(cellWidthSchema, doc.getCellProperties(section, paragraph, controlIndex, cell)).width,
    );
    expect(widths[0]).toBe(widths[1]);
  });

  it('AC-6 칸 글자의 줄바꿈은 칸 안 문단으로 나눈다', async () => {
    await openDocument('notice.hwpx');

    await json('insert_table', { after: 'b13', rows: 1, cols: 2, cells: [['첫 줄\n둘째 줄', '한 줄']] });

    expect((await readTable('b15'))?.cells.map(({ text }) => text)).toEqual(['첫 줄\n둘째 줄', '한 줄']);
    const { section, paragraph, controlIndex } = tableAddress('b15');
    const doc = rhwp.editor().doc;
    expect([0, 1].map((cell) => doc.getCellParagraphCount(section, paragraph, controlIndex, cell))).toEqual([2, 1]);
  });

  it('AC-6 개요 문단 뒤에 넣어도 표와 뒤 문단의 개요 번호가 밀리지 않는다', async () => {
    await openDocument('outline-demo.hwpx');
    const numbersBefore = (await outlineBlocks()).map(({ id, number }) => [id, number]);

    const result = await json('insert_table', { after: 'b1', rows: 2, cols: 2, cells: [['항목', '내용'], ['기간', '3개월']] });

    expect(result).toMatchObject({ inserted: 'b47', changed: [{ id: 'b47' }] });
    const blocks = await outlineBlocks();
    expect(blocks.find(({ id }) => id === 'b47')).toEqual({ id: 'b47', kind: 'table', text: '항목 | 내용 | 기간 | 3개월' });
    expect(blocks.filter(({ id }) => id !== 'b47').map(({ id, number }) => [id, number])).toEqual(numbersBefore);
  });

  it('AC-6 header 면 첫 행이 제목 셀·제목 줄 반복·굵은 글자다', async () => {
    await openDocument('notice.hwpx');

    await json('insert_table', { after: 'b13', rows: 2, cols: 2, cells: [['항목', '내용'], ['기간', '3개월']], header: true });

    const { section, paragraph, controlIndex } = tableAddress('b15');
    const doc = rhwp.editor().doc;
    expect([0, 1, 2, 3].map((cell) => isHeaderCell(doc, section, paragraph, controlIndex, cell))).toEqual([true, true, false, false]);
    expect(parseJson(tablePropsSchema, doc.getTableProperties(section, paragraph, controlIndex)).repeatHeader).toBe(true);
    const bold = (cell: number) =>
      parseJson(charPropsSchema, doc.getCellCharPropertiesAt(section, paragraph, controlIndex, cell, 0, 0)).bold;
    expect([0, 1, 2, 3].map(bold)).toEqual([true, true, false, false]);
  });

  it('AC-6 header 가 없으면 첫 행도 보통 칸이다', async () => {
    await openDocument('notice.hwpx');

    await json('insert_table', { after: 'b13', rows: 2, cols: 1, cells: [['항목'], ['기간']] });

    const { section, paragraph, controlIndex } = tableAddress('b15');
    const doc = rhwp.editor().doc;
    expect([0, 1].map((cell) => isHeaderCell(doc, section, paragraph, controlIndex, cell))).toEqual([false, false]);
    expect(parseJson(tablePropsSchema, doc.getTableProperties(section, paragraph, controlIndex)).repeatHeader).toBe(false);
  });

  it('AC-6 기준 블록 앞에도 넣고, 기준이 표 블록이면 그 표가 든 본문 문단 뒤에 넣는다(표 안에 표를 만들지 않는다)', async () => {
    await openDocument('notice.hwpx');

    expect(await json('insert_table', { before: 'b5', rows: 1, cols: 1, cells: [['앞 표']] })).toMatchObject({ inserted: 'b15' });
    expect(await json('insert_table', { after: 'b12', rows: 1, cols: 1, cells: [['표 뒤 표']] })).toMatchObject({ inserted: 'b16' });

    const ids = [...(await outline()).keys()];
    expect(ids.slice(3, 6)).toEqual(['b4', 'b15', 'b5']);
    expect(ids.slice(ids.indexOf('b12'), ids.indexOf('b12') + 3)).toEqual(['b12', 'b16', 'b13']);
    // 기존 표(b12)의 칸은 그대로다
    expect((await readTable('b12'))?.cells.some(({ text }) => text.includes('표 뒤 표'))).toBe(false);
    expect(tableAddress('b16').paragraph).toBe(tableAddress('b12').paragraph + 1);
  });

  it('AC-6 크기가 틀린 cells·1~50 밖 rows/cols 는 뷰어에 보내지 않고 거부한다', async () => {
    await openDocument('notice.hwpx');

    expect(await errorText('insert_table', { after: 'b5', rows: 2, cols: 2, cells: [['a', 'b'], ['c']] })).toBe(
      'cells 크기가 2×2 와 다릅니다.',
    );
    expect(await errorText('insert_table', { after: 'b5', rows: 1, cols: 2, cells: [['a', 'b'], ['c', 'd']] })).toBe(
      'cells 크기가 1×2 와 다릅니다.',
    );
    expect(await errorText('insert_table', { after: 'b5', rows: 0, cols: 2 })).toBe('표 크기는 행·열 1~50 입니다(행 0, 열 2).');
    expect(await errorText('insert_table', { after: 'b5', rows: 2, cols: 51 })).toBe('표 크기는 행·열 1~50 입니다(행 2, 열 51).');
    expect(requests('edit')).toHaveLength(0);
    expect(session.editCount).toBe(0);
  });

  it('AC-6 rows·cols 가 정수가 아니면 스펙 문구로 거부하고, 크기 검사는 id 확인보다 먼저다', async () => {
    await openDocument('notice.hwpx');

    expect(await errorText('insert_table', { after: 'b5', rows: 2.5, cols: 2 })).toBe('표 크기는 행·열 1~50 입니다(행 2.5, 열 2).');
    expect(await errorText('insert_table', { after: 'b99', rows: 0, cols: 2 })).toBe('표 크기는 행·열 1~50 입니다(행 0, 열 2).');
    expect(requests('edit')).toHaveLength(0);
  });

  it('rhwp 가 표를 넣으며 문단을 둘 이상 더하면 넣은 문단을 알릴 수 없어 거부하고 문서·id 표가 그대로다', async () => {
    await openDocument('notice.hwpx');
    const before = await outline();
    const doc = rhwp.editor().doc;
    const paragraphs = doc.getParagraphCount(0);
    const create = doc.createTable.bind(doc);
    // 표 아래 빈 문단을 둘 붙이는 rhwp 를 흉내낸다(id 표·relocate 는 넣은 문단을 하나로 알면 뒤 id 가 한 칸 어긋난다)
    doc.createTable = (section, paragraph, offset, rows, cols) => {
      const result = create(section, paragraph, offset, rows, cols);
      doc.insertParagraph(section, paragraph + 1);
      return result;
    };

    expect(await errorText('insert_table', { after: 'b5', rows: 1, cols: 1 })).toBe(
      '표를 넣으며 생긴 문단(2개)을 확인하지 못해 표를 넣지 않았습니다.',
    );
    expect(session.editCount).toBe(0);
    expect(doc.getParagraphCount(0)).toBe(paragraphs);
    expect(await outline()).toEqual(before);
  });

  it('AC-6 insert_table 로 만든 표(머리글·두 줄 칸)는 save_document 저장 전 검증을 통과하고, 다시 열어도 표·머리글·칸 글자가 같다', async () => {
    await openDocument('notice.hwpx');
    await json('insert_table', {
      after: 'b5',
      rows: 2,
      cols: 2,
      cells: [
        ['항목', '내용'],
        ['기간', '11월\n~ 12월'],
      ],
      header: true,
    });
    const blocksBefore = (await outlineBlocks()).map(({ kind, text, number }) => ({ kind, text, number }));
    const cellsBefore = (await readTable('b15'))?.cells;
    const path = join(await mkdtemp(join(tmpdir(), 'docbridge-table-')), '표.hwpx');

    const saved = z.object({ path: z.string(), verified: z.object({ blockCount: z.number() }) }).parse(await json('save_document', { path }));
    expect(saved).toMatchObject({ path, verified: { blockCount: blocksBefore.length } });

    await json('open_document', { path });
    const reopened = await outlineBlocks();
    expect(reopened.map(({ kind, text, number }) => ({ kind, text, number }))).toEqual(blocksBefore);
    // 다시 열면 id 는 문서 순서로 새로 붙는다. 넣은 표는 b5 뒤라 문서의 첫 표다
    const newTable = reopened.find(({ kind }) => kind === 'table')?.id ?? '';
    expect((await readTable(newTable))?.cells).toEqual(cellsBefore);
    const { section, paragraph, controlIndex } = tableAddress(newTable);
    const doc = rhwp.editor().doc;
    expect([0, 1, 2, 3].map((cell) => isHeaderCell(doc, section, paragraph, controlIndex, cell))).toEqual([true, true, false, false]);
    expect(parseJson(tablePropsSchema, doc.getTableProperties(section, paragraph, controlIndex)).repeatHeader).toBe(true);
    expect(doc.getCellParagraphCount(section, paragraph, controlIndex, 3)).toBe(2);
  });

  it('before·after 를 둘 다 주거나 없는 id 면 거부하고, 구역 첫 문단 앞은 뷰어가 거부해 문서·id 표가 그대로다', async () => {
    await openDocument('notice.hwpx');
    const before = await outline();
    const paragraphs = rhwp.editor().doc.getParagraphCount(0);

    expect(await errorText('insert_table', { before: 'b5', after: 'b6', rows: 1, cols: 1 })).toBe('before 와 after 중 하나만 주세요.');
    expect(await errorText('insert_table', { after: 'b99', rows: 1, cols: 1 })).toBe(
      '없는 블록 id 입니다: b99. get_outline 을 다시 불러 지금 블록 id 를 확인하세요.',
    );
    expect(requests('edit')).toHaveLength(0);
    expect(await errorText('insert_table', { before: 'b1', rows: 1, cols: 1 })).toBe(
      '구역 첫 문단 앞에는 표를 넣을 수 없습니다. 첫 문단 뒤에 넣으세요.',
    );
    expect(session.editCount).toBe(0);
    expect(await outline()).toEqual(before);
    expect(rhwp.editor().doc.getParagraphCount(0)).toBe(paragraphs);
  });

  it('넣은 표는 다른 블록처럼 move_blocks 로 옮기고 delete_blocks 로 지울 수 있다', async () => {
    await openDocument('notice.hwpx');
    await json('insert_table', { after: 'b5', rows: 1, cols: 1, cells: [['옮길 표']] });

    expect(await json('move_blocks', { ids: ['b15'], after: 'b13' })).toMatchObject({ moved: ['b15'] });
    const ids = [...(await outline()).keys()];
    expect(ids.slice(ids.indexOf('b13'), ids.indexOf('b13') + 2)).toEqual(['b13', 'b15']);
    expect(await json('delete_blocks', { ids: ['b15'] })).toEqual({ deleted: ['b15'] });
    expect((await outline()).has('b15')).toBe(false);
  });

  it('AC-6 표 넣기는 편집 하나라 undo 한 번에 표와 넣은 문단이 사라지고, 그 뒤 편집도 id 가 맞다', async () => {
    await openDocument('notice.hwpx');
    const before = await outline();
    const paragraphs = rhwp.editor().doc.getParagraphCount(0);

    await json('insert_table', { after: 'b5', rows: 2, cols: 2, header: true });
    await json('insert_paragraph', { after: 'b15', text: '표 아래 설명' });
    expect([...(await outline()).keys()].slice(4, 8)).toEqual(['b5', 'b15', 'b16', 'b6']);

    expect(await json('undo', { steps: 2 })).toEqual({ undone: 2, edits: ['insert_paragraph after b15', 'insert_table after b5'] });
    expect(await outline()).toEqual(before);
    expect(rhwp.editor().doc.getParagraphCount(0)).toBe(paragraphs);
  });
});
