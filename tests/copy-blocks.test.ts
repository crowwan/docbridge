// SPEC-007 copy_blocks 도구(#64): 원본 탭이 HWPX 바이트를 내보내고 → 서버 → 대상 탭이 편집 공용 경로로 넣는다.
// 탭마다 rhwp 테스트 뷰어가 붙은 MCP 서버로 돌린다(여러 문서 테스트와 같은 구성).
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBlankDocument } from '../src/core/rhwp-node.ts';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { DocumentSessions } from '../src/server/documents.ts';
import { NOTHING_TO_UNDO } from '../src/server/edit-tools.ts';
import { createMcpServer } from '../src/server/mcp.ts';
import { buildCopySource, SOURCE_ONLY_STYLE } from './copy-source.ts';
import { FakeViewer } from './fake-viewer.ts';
import { fixturePath } from './fixtures.ts';
import { rhwpViewer, type RhwpViewer } from './rhwp-viewer.ts';

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});
const outlineSchema = z.object({
  doc: z.string(),
  blocks: z.array(z.object({ id: z.string(), kind: z.string(), text: z.string().optional(), number: z.string().optional(), name: z.string().optional() })),
});
const copyResultSchema = z.object({
  doc: z.string(),
  inserted: z.array(z.string()),
  changed: z.array(z.object({ id: z.string(), number: z.string().optional(), text: z.string() })),
  warnings: z.array(z.string()).optional(),
});
const stylesSchema = z.object({ styles: z.array(z.object({ name: z.string() })) });

interface Tab {
  socket: FakeViewer;
  rhwp: RhwpViewer;
}

const idRange = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `b${from + i}`);

describe('SPEC-007 copy_blocks — 문서 사이 문단·표 복사', () => {
  let bridge: Bridge;
  let sessions: DocumentSessions;
  let client: Client;
  let dir: string;
  let tabs: Map<string, Tab>;
  const sockets: FakeViewer[] = [];

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
  const outline = async (doc?: string) => outlineSchema.parse(await json('get_outline', doc === undefined ? {} : { doc }));
  /** 번호 문단은 "번호 글자 앞 6자", 표는 "표", 누름틀은 "누름틀 이름" */
  const lines = async (doc: string) =>
    (await outline(doc)).blocks.map(({ kind, text, number, name }) => {
      if (kind === 'table') return '표';
      if (kind === 'field') return `누름틀 ${name ?? ''}`;
      return `${number === undefined ? '' : `${number} `}${(text ?? '').slice(0, 6)}`;
    });
  const copyBlocks = async (args: Record<string, unknown>) => copyResultSchema.parse(await json('copy_blocks', args));
  const tab = (doc: string): Tab => {
    const found = tabs.get(doc);
    if (found === undefined) throw new Error(`${doc} 탭이 없다`);
    return found;
  };
  const copy = async (fixture: string, name: string) => {
    const path = join(dir, name);
    await copyFile(fixturePath(fixture), path);
    return path;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'docbridge-copy-'));
    bridge = await startBridge({ port: 0, viewerDir: tmpdir() });
    tabs = new Map();
    // 브라우저 대신: 문서 탭 주소를 열면 그 주소로 탭이 붙는다
    const openBrowser = (url: string) => {
      const doc = new URL(url).searchParams.get('doc') ?? '';
      void FakeViewer.connect(url).then((socket) => {
        sockets.push(socket);
        const rhwp = rhwpViewer();
        socket.serve(rhwp.handle);
        tabs.set(doc, { socket, rhwp });
      });
    };
    sessions = new DocumentSessions(bridge, { openBrowser, tabCloseGraceMs: 0 });
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

  it('AC-5 문단·표를 서식째 다른 문서에 넣고, 대상 번호가 다시 매겨지며, undo 한 번에 돌아간다. 원본은 그대로다', async () => {
    await json('open_document', { path: fixturePath('notice.hwpx') });
    await json('open_document', { path: await copy('notice.hwpx', '공문 사본.hwpx') });
    const before = { d1: await lines('d1'), d2: await lines('d2') };

    // d1 의 "3. 회신 기한" + 일정 표(b11·b12) → d2 "2. 하반기"(b7) 앞
    const result = await copyBlocks({ from: 'd1', ids: ['b11', 'b12'], to: 'd2', before: 'b7' });

    expect(result.doc).toBe('d2');
    expect(result.inserted).toEqual(['b15', 'b16']);
    expect(result.changed.slice(0, 2)).toEqual([
      { id: 'b15', number: '2.', text: '회신 기한: 2026. 11. 14.(금)까지 참석 인원을 회신하여 주시…' },
      { id: 'b16', text: expect.stringContaining('구분') },
    ]);
    // 대상 번호가 다시 매겨진 문단도 바뀐 블록으로
    expect(result.changed.map(({ id, number }) => `${id} ${number ?? ''}`)).toEqual(expect.arrayContaining(['b7 3.', 'b11 4.']));
    expect((await lines('d2')).filter((line) => /^\d\. /.test(line))).toEqual(['1. 관련: 가나', '2. 회신 기한:', '3. 하반기 주민', '4. 회신 기한:']);
    // 원본은 그대로, 편집도 없다
    expect(await lines('d1')).toEqual(before.d1);
    expect([sessions.get('d1').editCount, sessions.get('d2').unsavedEdits]).toEqual([0, 1]);
    expect(tab('d1').socket.history.map(({ method }) => method)).toContain('export_hwpx');
    expect(tab('d1').socket.history.map(({ method }) => method)).not.toContain('edit');

    expect(await json('undo', { doc: 'd2' })).toMatchObject({ doc: 'd2', undone: 1, edits: ['copy_blocks d1 b11, b12 → before b7'] });
    expect(await lines('d2')).toEqual(before.d2);
  });

  it('AC-6 대상에 같은 스타일이 없으면 원본 스타일 이름·모양 그대로 들어가고, 있으면 대상 스타일이 되어 같은 이름 스타일이 둘 남지 않는다', async () => {
    const sourcePath = join(dir, '원본.hwpx');
    await writeFile(sourcePath, buildCopySource().exportHwpx());
    await json('open_document', { path: sourcePath });
    await json('open_document', { path: await copy('report.hwpx', '보고서.hwpx') });
    const stylesBefore = stylesSchema.parse(await json('list_styles', { doc: 'd2' })).styles.map(({ name }) => name);
    const sourceIds = (await outline('d1')).blocks.map(({ id }) => id);

    // 번호 문단(b6)부터 끝(그림·"강조 문단"·"개요 1" 스타일 문단)까지
    await copyBlocks({ from: 'd1', ids: sourceIds.slice(sourceIds.indexOf('b6')), to: 'd2', after: 'b1' });

    const names = stylesSchema.parse(await json('list_styles', { doc: 'd2' })).styles.map(({ name }) => name);
    expect(names).toEqual([...stylesBefore, SOURCE_ONLY_STYLE.name]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('가져올 수 없는 개체(각주)가 든 문단이 범위에 있으면 아무것도 넣지 않고 거부한다(편집도 남지 않는다)', async () => {
    const doc = createBlankDocument();
    doc.insertText(0, 0, 0, '첫째');
    doc.splitParagraph(0, 0, 2);
    doc.insertText(0, 1, 0, '보통 문단');
    doc.splitParagraph(0, 1, 5);
    doc.insertText(0, 2, 0, '각주 문단');
    doc.insertFootnote(0, 2, 2);
    const footnotePath = join(dir, '각주.hwpx');
    await writeFile(footnotePath, doc.exportHwpx());
    await json('open_document', { path: footnotePath });
    await json('open_document', { path: fixturePath('report.hwpx') });
    const before = await lines('d2');

    expect(await errorText('copy_blocks', { from: 'd1', ids: ['b2', 'b3'], to: 'd2', after: 'b1' })).toBe(
      '이 문단은 복사할 수 없습니다(각주): b3. 글자만 가져오려면 read_blocks 와 insert_paragraph 를 쓰세요.',
    );
    expect(await lines('d2')).toEqual(before);
    expect(await errorText('undo', { doc: 'd2' })).toBe(NOTHING_TO_UNDO);
  });

  it('from = to 면 같은 문서 안 사본이다(옮기기가 아니다). 누름틀이 든 문단은 문단 블록과 누름틀 블록이 모두 새 id 를 받는다', async () => {
    await json('open_document', { path: fixturePath('notice.hwpx') });
    const before = await lines('d1');

    const result = await copyBlocks({ from: 'd1', ids: ['b2'], to: 'd1', after: 'b12' });

    expect(result.inserted).toEqual(['b15', 'b16']);
    const after = await lines('d1');
    expect(after).toHaveLength(before.length + 2);
    // 표(b12, 12번째 블록) 뒤에 "수신 …" 문단과 그 누름틀 "수신"
    expect(after.slice(0, 12)).toEqual(before.slice(0, 12));
    expect(after.slice(12, 14)).toEqual(before.slice(1, 3));
    expect(after.slice(14)).toEqual(before.slice(12));
    expect((await outline('d1')).blocks.slice(12, 14).map(({ id }) => id)).toEqual(['b15', 'b16']);
  });

  it('원본 범위 규칙은 move_blocks 와 같고(이어진 블록), 원본 쪽 오류는 원본 문서 이름을 붙인다. 대상 기준은 insert_paragraph 와 같다', async () => {
    await json('open_document', { path: fixturePath('notice.hwpx') });
    await json('open_document', { path: fixturePath('report.hwpx') });

    expect(await errorText('copy_blocks', { from: 'd1', ids: ['b6', 'b8'], to: 'd2', after: 'b1' })).toBe(
      '원본 d1: 복사할 블록이 문서에서 이어져 있지 않습니다. 사이 블록 b7 도 ids 에 넣거나 따로 복사하세요.',
    );
    expect(await errorText('copy_blocks', { from: 'd1', ids: ['b99'], to: 'd2', after: 'b1' })).toContain('원본 d1: 없는 블록 id 입니다: b99.');
    expect(await errorText('copy_blocks', { from: 'd1', ids: ['b6'], to: 'd2', after: 'b999' })).toContain('없는 블록 id 입니다: b999.');
    expect(await errorText('copy_blocks', { from: 'd1', ids: ['b6'], to: 'd2', before: 'b1' })).toContain('구역 첫 문단 앞에는 넣을 수 없습니다.');
    expect(await errorText('copy_blocks', { from: 'd9', ids: ['b6'], to: 'd2', after: 'b1' })).toBe('열린 문서에 d9 가 없습니다. list_documents 로 확인해 주세요.');
  });

  it('복사한 뒤 doc 없이 부른 도구는 대상 문서를 본다', async () => {
    await json('open_document', { path: fixturePath('notice.hwpx') });
    await json('open_document', { path: fixturePath('report.hwpx') });
    await json('get_outline', { doc: 'd1' });

    await copyBlocks({ from: 'd1', ids: ['b11'], to: 'd2', after: 'b1' });

    expect((await outline()).doc).toBe('d2');
  });

  it('from 이나 to 가 없는 문서면 오류만 내고 마지막으로 쓴 문서는 그대로다(두 문서를 모두 확인한 뒤 고른다)', async () => {
    await json('open_document', { path: fixturePath('notice.hwpx') });
    await json('open_document', { path: fixturePath('report.hwpx') });

    expect(await errorText('copy_blocks', { from: 'd1', ids: ['b11'], to: 'd9', after: 'b1' })).toBe('열린 문서에 d9 가 없습니다. list_documents 로 확인해 주세요.');
    expect((await outline()).doc).toBe('d2');
    expect(await errorText('copy_blocks', { from: 'd9', ids: ['b11'], to: 'd1', after: 'b1' })).toBe('열린 문서에 d9 가 없습니다. list_documents 로 확인해 주세요.');
    expect((await outline()).doc).toBe('d2');
  });
});
