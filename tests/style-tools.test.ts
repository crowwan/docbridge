// SPEC-003 스타일 도구(#37): list_styles · insert_paragraph style · set_style 을 MCP 도구 → 편집 공용 경로 → rhwp 테스트 뷰어로 본다.
// report.hwpx 는 모든 문단이 바탕글 스타일에 직접 문단 모양(개요·가운데 정렬)을 건 문서라, "직접 문단 모양이 있어도" 를 그대로 확인할 수 있다.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { exportVerifiedHwpx } from '../src/core/hwpx-export.ts';
import { parseJson } from '../src/core/json.ts';
import { createBlankDocument } from '../src/core/rhwp-node.ts';
import { findStyle } from '../src/core/styles.ts';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { createMcpServer } from '../src/server/mcp.ts';
import { DocumentSessions } from '../src/server/documents.ts';
import type { RequestMessage } from '../src/shared/protocol.ts';
import { FakeViewer } from './fake-viewer.ts';
import { fixturePath } from './fixtures.ts';
import { withoutDoc } from './tool-result.ts';
import { rhwpViewer, type RhwpViewer } from './rhwp-viewer.ts';

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});

const outlineSchema = z.object({
  blocks: z.array(z.object({ id: z.string(), kind: z.string(), text: z.string(), number: z.string().optional() })),
});
const paraPropsSchema = z.looseObject({ alignment: z.string(), headType: z.string() });
const charPropsSchema = z.looseObject({ fontSize: z.number(), bold: z.boolean() });
const styleAtSchema = z.object({ name: z.string() });

describe('SPEC-003 스타일 도구 (list_styles · insert_paragraph style · set_style)', () => {
  let bridge: Bridge;
  let sessions: DocumentSessions;
  let client: Client;
  let viewer: FakeViewer;
  let rhwp: RhwpViewer;

  const call = async (name: string, args: Record<string, unknown> = {}) =>
    toolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const json = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const result = await call(name, args);
    if (result.isError) throw new Error(result.content[0]?.text);
    return withoutDoc(JSON.parse(result.content[0]?.text ?? ''));
  };
  /** 다른 파일을 이 탭에서 연다: 지금 문서를 닫고(빈 탭이 된다) 연다 — 문서마다 탭이라(SPEC-007) 그냥 열면 새 탭이 필요하다 */
  const openInPlace = async (path: string) => {
    await json('close_document', { discard: true });
    return json('open_document', { path });
  };
  const errorText = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    return result.content[0]?.text ?? '';
  };
  const requests = (method: RequestMessage['method']) => viewer.history.filter((request) => request.method === method);
  /** get_outline 의 id → "번호 글자"(번호 없으면 글자만) */
  const numbered = async () =>
    new Map(
      outlineSchema
        .parse(await json('get_outline'))
        .blocks.map(({ id, text, number }) => [id, number === undefined ? text : `${number} ${text}`]),
    );
  /** 뷰어 문서에서 블록 id 의 문단 위치(테스트가 rhwp 로 모양을 직접 읽는다) */
  const paragraphOf = (id: string) => {
    const anchor = sessions.document?.ids.anchor(id);
    if (anchor === undefined) throw new Error(`${id} 가 id 표에 없다`);
    return anchor.paragraph;
  };
  const doc = () => rhwp.editor().doc;
  const paraProps = (id: string) => parseJson(paraPropsSchema, doc().getParaPropertiesAt(0, paragraphOf(id)));
  const charProps = (id: string) => parseJson(charPropsSchema, doc().getCharPropertiesAt(0, paragraphOf(id), 0));
  const styleName = (id: string) => parseJson(styleAtSchema, doc().getStyleAt(0, paragraphOf(id))).name;

  beforeEach(async () => {
    bridge = await startBridge({ port: 0, viewerDir: tmpdir() });
    sessions = new DocumentSessions(bridge, { openBrowser: vi.fn() });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(sessions).connect(serverSide);
    client = new Client({ name: 'docbridge-test', version: '0.0.0' });
    await client.connect(clientSide);
    viewer = await FakeViewer.connect(bridge.viewerUrl);
    rhwp = rhwpViewer();
    viewer.serve(rhwp.handle);
    await json('open_document', { path: fixturePath('report.hwpx') });
  });

  afterEach(async () => {
    viewer.close();
    await client.close();
    await bridge.close();
  });

  it('AC-3 list_styles 는 문단 스타일 이름·영문 이름과 개요 번호 여부·수준을 돌려준다(글자 스타일은 없다)', async () => {
    const { styles } = z.object({ styles: z.array(z.looseObject({ name: z.string() })) }).parse(await json('list_styles'));

    expect(styles.slice(0, 4)).toEqual([
      { name: '바탕글', englishName: 'Normal', outline: false },
      { name: '본문', englishName: 'Body', outline: false },
      { name: '개요 1', englishName: 'Outline 1', outline: true, outlineLevel: 1 },
      { name: '개요 2', englishName: 'Outline 2', outline: true, outlineLevel: 2 },
    ]);
    expect(styles.map(({ name }) => name)).not.toContain('쪽 번호');
    expect(requests('list_styles')).toHaveLength(1);
  });

  it('AC-3 개요 번호 여부는 이름이 아니라 스타일 문단 모양으로 본다 — 번호 없는 모양으로 바꾼 "개요 1" 은 outline 이 아니다', async () => {
    const blank = createBlankDocument();
    blank.updateStyleShapes(findStyle(blank, '개요 1').id, '{}', JSON.stringify({ headType: 'None' }));
    const path = join(await mkdtemp(join(tmpdir(), 'docbridge-styles-')), '양식.hwpx');
    await writeFile(path, exportVerifiedHwpx(blank).bytes);
    await openInPlace(path);

    const { styles } = z.object({ styles: z.array(z.looseObject({ name: z.string() })) }).parse(await json('list_styles'));

    expect(styles.find(({ name }) => name === '개요 1')).toEqual({ name: '개요 1', englishName: 'Outline 1', outline: false });
    expect(styles.find(({ name }) => name === '개요 2')).toMatchObject({ outline: true, outlineLevel: 2 });
  });

  it('AC-4 insert_paragraph 에 style 을 주면 기준 문단(가운데 정렬·18pt 굵게)을 따르지 않고 그 스타일이 되고, 개요 스타일 문단은 번호가 매겨진다', async () => {
    // b1 = 가운데 정렬 직접 문단 모양 + 18pt 굵게 직접 글자 서식인 제목
    expect(paraProps('b1')).toMatchObject({ alignment: 'center' });

    const result = await json('insert_paragraph', { after: 'b1', text: '요약', style: '개요 1' });

    // 결과의 changed 는 새 문단과 번호가 다시 매겨진 문단(넣은 뒤 번호)
    expect(result).toMatchObject({
      inserted: 'b40',
      changed: expect.arrayContaining([
        { id: 'b40', number: '1.', text: '요약' },
        { id: 'b2', number: '2.', text: '개요' },
        { id: 'b7', number: '3.', text: '이용 현황' },
      ]),
    });
    expect(styleName('b40')).toBe('개요 1');
    expect(paraProps('b40')).toMatchObject({ alignment: 'justify', headType: 'Outline' });
    expect(charProps('b40')).toMatchObject({ fontSize: 1000, bold: false });
    const lines = await numbered();
    expect([lines.get('b1'), lines.get('b40'), lines.get('b2'), lines.get('b7')]).toEqual([
      '2026년 공공도서관 이용 현황 보고',
      '1. 요약',
      '2. 개요',
      '3. 이용 현황',
    ]);
  });

  it('AC-4 style 로 넣은 새 문단은 기준 문단 글자 모양을 맞추지 않는다(쓰지 않는 글자 모양 id 를 만들지 않는다)', async () => {
    // b2 "개요"(10pt 굵게) 앞: rhwp 는 앞 문단 b1(18pt 굵게) 끝 글자 모양을 물려줘, 기준 모양을 맞추려면 글자 서식을 새로 건다
    const applyCharFormat = vi.spyOn(doc(), 'applyCharFormat');

    await json('insert_paragraph', { before: 'b2', text: '요약', style: '본문' });

    expect(applyCharFormat).not.toHaveBeenCalled();
    expect(charProps('b40')).toMatchObject({ fontSize: 1000, bold: false });
    // 스타일이 없으면 지금처럼 기준 문단(b2 첫 글자) 모양을 맞춘다
    await json('insert_paragraph', { before: 'b2', text: '기준 모양' });
    expect(applyCharFormat).toHaveBeenCalled();
  });

  it('AC-4 style 은 영문 이름도 받고, 넣기와 스타일 적용은 한 편집이라 undo 한 번에 넣기 전으로 돌아간다', async () => {
    const before = await numbered();

    await json('insert_paragraph', { after: 'b2', text: '배경', style: 'Outline 2' });
    expect((await numbered()).get('b40')).toBe('가. 배경');

    expect(await json('undo')).toEqual({ undone: 1, edits: ['insert_paragraph after b2 (Outline 2)'] });
    expect(await numbered()).toEqual(before);
  });

  it('AC-4 없는 스타일이면 문단을 넣지 않고 스펙 문구로 거부한다(편집 기록·id 표는 그대로)', async () => {
    const before = await numbered();

    expect(await errorText('insert_paragraph', { after: 'b1', text: '요약', style: '큰제목' })).toBe(
      '없는 스타일입니다: 큰제목. list_styles 로 목록을 보세요.',
    );
    expect(sessions.editCount).toBe(0);
    expect(await numbered()).toEqual(before);
  });

  it('AC-5 set_style 은 여러 문단 블록을 한 편집으로 바꾸고, 바뀐 블록에 번호가 다시 매겨진 문단도 담는다. undo 한 번에 돌아온다', async () => {
    const before = await numbered();

    // b4·b6 = "가."·"나." 아래 본문 문단(직접 문단 모양) → 개요 1
    const result = await json('set_style', { ids: ['b4', 'b6'], style: '개요 1' });

    const lines = await numbered();
    expect([lines.get('b2'), lines.get('b4'), lines.get('b6'), lines.get('b7'), lines.get('b12')]).toEqual([
      '1. 개요',
      `2. ${before.get('b4')}`,
      `3. ${before.get('b6')}`,
      '4. 이용 현황',
      '5. 분기별 비교',
    ]);
    expect(styleName('b4')).toBe('개요 1');
    expect(result).toMatchObject({
      changed: expect.arrayContaining([
        expect.objectContaining({ id: 'b4', number: '2.' }),
        expect.objectContaining({ id: 'b6', number: '3.' }),
        // 고르지 않았지만 번호가 바뀐 문단
        expect.objectContaining({ id: 'b7', number: '4.' }),
        expect.objectContaining({ id: 'b23', number: '7.' }),
      ]),
    });
    // 번호가 그대로인 문단(b2 "1.")은 바뀐 블록이 아니다
    expect(z.object({ changed: z.array(z.object({ id: z.string() })) }).parse(result).changed.map(({ id }) => id)).not.toContain('b2');

    expect(await json('undo')).toEqual({ undone: 1, edits: ['set_style b4, b6 → 개요 1'] });
    expect(await numbered()).toEqual(before);
  });

  it('AC-5 set_style 로 개요 문단을 본문으로 바꾸면 번호가 사라지고 뒤 개요 번호가 당겨진다', async () => {
    await json('set_style', { ids: ['b2'], style: '본문' });

    const lines = await numbered();
    expect([lines.get('b2'), lines.get('b7')]).toEqual(['개요', '1. 이용 현황']);
  });

  it('AC-5 표·누름틀 블록은 뷰어에 보내지 않고 거부한다', async () => {
    await openInPlace(fixturePath('notice.hwpx'));

    // notice: b12 = 표, b3 = 누름틀
    expect(await errorText('set_style', { ids: ['b11', 'b12', 'b3'], style: '개요 1' })).toBe(
      '표·누름틀 블록은 스타일을 바꿀 수 없습니다: b12, b3. 문단 블록 id 를 주세요(표·누름틀이 든 문단은 get_outline 의 그 문단 블록).',
    );
    expect(requests('edit')).toHaveLength(0);
    expect(sessions.editCount).toBe(0);
  });

  it('AC-5 없는 스타일·없는 id 는 바꾸지 않고 거부한다', async () => {
    const before = await numbered();

    expect(await errorText('set_style', { ids: ['b4'], style: '쪽 번호' })).toBe('없는 스타일입니다: 쪽 번호. list_styles 로 목록을 보세요.');
    expect(await errorText('set_style', { ids: ['b99'], style: '개요 1' })).toBe(
      '없는 블록 id 입니다: b99. get_outline 을 다시 불러 지금 블록 id 를 확인하세요.',
    );
    expect(sessions.editCount).toBe(0);
    expect(await numbered()).toEqual(before);
  });
});
