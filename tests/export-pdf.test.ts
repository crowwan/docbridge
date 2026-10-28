// SPEC-008 PDF 로 내보내기(export_pdf, #108): 뷰어(rhwp 테스트 뷰어)가 쪽 SVG·글자 배치를 주고 서버가 PDF 를 만들어 쓴다.
// 글꼴은 시험 글꼴(tests/fonts/, Noto Sans KR 부분 집합, OFL)만 써서 컴퓨터마다 결과가 같다.
import { chmod, copyFile, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractBlocks } from '../src/core/blocks.ts';
import { fontLibraryFromFiles } from '../src/core/pdf-fonts-node.ts';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { DocumentSessions } from '../src/server/documents.ts';
import { PAGE_BATCH, parsePages, unsavedEditsWarning } from '../src/server/export-pdf-tool.ts';
import { createMcpServer } from '../src/server/mcp.ts';
import type { RequestMessage } from '../src/shared/protocol.ts';
import { compact, inspectPdf, pageContents } from '../scripts/pdf-check/inspect.ts';
import { FakeViewer } from './fake-viewer.ts';
import { fixturePath, openFixture } from './fixtures.ts';
import { rhwpViewerHandler } from './rhwp-viewer.ts';
import { withoutDoc } from './tool-result.ts';

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});
const exportResultSchema = z.object({
  path: z.string(),
  pageCount: z.number(),
  bytes: z.number(),
  warnings: z.array(z.string()).optional(),
});
const documentsSchema = z.object({ documents: z.array(z.object({ doc: z.string(), unsavedEdits: z.number() })) });

const TEST_FONT = fileURLToPath(new URL('./fonts/NotoSansKR-test.ttf', import.meta.url));
const testFonts = () => fontLibraryFromFiles([TEST_FONT], { serif: ['Noto Sans KR'], 'sans-serif': ['Noto Sans KR'], fallback: [] });

describe('SPEC-008 쪽 범위 읽기 (pages)', () => {
  it('"1-3,5" 처럼 쪽 번호·범위를 쉼표로 이어 받고, 0 부터 센 쪽 차례(겹치면 한 번, 오름차순)로 바꾼다', () => {
    expect(parsePages('1-3,5', 5)).toEqual([0, 1, 2, 4]);
    expect(parsePages(' 3 , 1-2 ,2', 3)).toEqual([0, 1, 2]);
    expect(parsePages('2', 2)).toEqual([1]);
  });

  it('범위가 문서 쪽 수를 넘거나 모양이 틀리면 거부한다', () => {
    expect(() => parsePages('1-4', 3)).toThrow('쪽 범위가 문서 쪽 수(3쪽)를 넘습니다: 1-4');
    expect(() => parsePages('0', 3)).toThrow('쪽 번호는 1부터입니다: 0');
    expect(() => parsePages('3-1', 3)).toThrow('쪽 범위의 앞이 뒤보다 큽니다: 3-1');
    expect(() => parsePages('1,,2', 3)).toThrow('쪽 범위를 읽을 수 없습니다: "1,,2" (예: "1-3,5")');
    expect(() => parsePages('첫 쪽', 3)).toThrow('쪽 범위를 읽을 수 없습니다: "첫 쪽" (예: "1-3,5")');
  });
});

describe('SPEC-008 PDF 로 내보내기 (export_pdf)', () => {
  let bridge: Bridge;
  let sessions: DocumentSessions;
  let client: Client;
  let viewer: FakeViewer;
  let dir: string;

  const call = async (name: string, args: Record<string, unknown> = {}) =>
    toolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const json = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const result = await call(name, args);
    if (result.isError) throw new Error(result.content[0]?.text);
    return withoutDoc(JSON.parse(result.content[0]?.text ?? ''));
  };
  const exportPdf = async (args: Record<string, unknown> = {}) => exportResultSchema.parse(await json('export_pdf', args));
  const exportError = async (args: Record<string, unknown> = {}) => {
    const result = await call('export_pdf', args);
    expect(result.isError).toBe(true);
    return result.content[0]?.text ?? '';
  };
  const openCopy = async (fixture: string, name: string) => {
    const path = join(dir, name);
    await copyFile(fixturePath(fixture), path);
    await json('open_document', { path });
    return path;
  };
  const pdfText = async (path: string) => compact((await inspectPdf(new Uint8Array(await readFile(path)))).pages.map((page) => page.text).join(''));
  const pageRequests = () =>
    viewer.history.filter((request): request is Extract<RequestMessage, { method: 'export_pdf_pages' }> => request.method === 'export_pdf_pages');
  const unsavedEdits = async () => documentsSchema.parse(await json('list_documents')).documents[0]?.unsavedEdits;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'docbridge-export-pdf-'));
    bridge = await startBridge({ port: 0, viewerDir: tmpdir() });
    sessions = new DocumentSessions(bridge, { openBrowser: () => {}, fonts: testFonts });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(sessions, { fonts: testFonts }).connect(serverSide);
    client = new Client({ name: 'docbridge-test', version: '0.0.0' });
    await client.connect(clientSide);
    viewer = await FakeViewer.connect(bridge.viewerUrl);
    viewer.serve(rhwpViewerHandler());
  });

  afterEach(async () => {
    viewer.close();
    await client.close();
    await bridge.close();
  });

  it('기본 경로(문서 옆 <이름>.pdf)에 PDF 를 만들고, 결과 쪽 수가 문서 쪽 수와 같다', async () => {
    // AC-1
    await openCopy('outline-demo.hwpx', '개요.hwpx');

    const result = await exportPdf();

    const path = join(dir, '개요.pdf');
    const written = new Uint8Array(await readFile(path));
    expect(result).toEqual({ path, pageCount: 3, bytes: written.length });
    expect((await inspectPdf(written)).pages).toHaveLength(openFixture('outline-demo.hwpx').pageCount());
    expect(await readdir(dir)).toEqual(['개요.hwpx', '개요.pdf']);
  });

  it('PDF 안 글자를 뽑으면 문서 본문 글자가 나온다(선택·검색 가능)', async () => {
    // AC-2
    await openCopy('notice.hwpx', '공문.hwpx');

    const text = await pdfText((await exportPdf()).path);

    const doc = openFixture('notice.hwpx');
    for (const block of extractBlocks(doc)) {
      const body = block.kind === 'paragraph' ? compact(`${block.number ?? ''}${block.text}`) : '';
      if (body.length > 0) expect(text).toContain(body);
    }
  });

  it('하이라이트·note 가 있을 때 내보낸 PDF 는 표시를 지운 뒤 내보낸 PDF 와 그리기 명령·글자가 같다(쪽 SVG 는 문서 내용만)', async () => {
    // AC-3: 표시는 뷰어 DOM 오버레이라 쪽 SVG(pdfPages — 뷰어·테스트 뷰어 공용)에 없다. 표시가 SVG·글자 배치로 새면 그리기 명령이나 글자가 달라져 실패한다
    // (실제 뷰어에서 표시가 있을 때와 없을 때 SVG 가 같은지는 E2E e2e/export-pdf.spec.ts)
    await openCopy('notice.hwpx', '공문.hwpx');
    await json('highlight', { targets: [{ id: 'b1' }], note: '여기 확인할 메모' });
    expect(viewer.history.some((request) => request.method === 'highlight' && request.params.note === '여기 확인할 메모')).toBe(true);
    const marked = await exportPdf({ path: '표시 있음.pdf' });

    await json('clear_highlight');
    const clean = await exportPdf({ path: '표시 없음.pdf' });

    const markedBytes = new Uint8Array(await readFile(marked.path));
    expect(await pdfText(marked.path)).not.toContain('여기확인할메모');
    expect(await pdfText(marked.path)).toBe(await pdfText(clean.path));
    expect(await pageContents(markedBytes)).toEqual(await pageContents(new Uint8Array(await readFile(clean.path))));
  });

  it('pages 로 일부 쪽만 내보내고, 범위 밖은 뷰어에 묻기 전에 거부한다', async () => {
    // AC-4
    await openCopy('outline-demo.hwpx', '개요.hwpx');

    const result = await exportPdf({ pages: '1,3' });
    expect(result.pageCount).toBe(2);
    expect((await inspectPdf(new Uint8Array(await readFile(result.path)))).pages).toHaveLength(2);
    expect(pageRequests().at(-1)?.params).toEqual({ pages: [0, 2] });

    const before = pageRequests().length;
    expect(await exportError({ pages: '2-4' })).toBe('쪽 범위가 문서 쪽 수(3쪽)를 넘습니다: 2-4');
    expect(pageRequests()).toHaveLength(before);
  });

  it(`쪽은 ${PAGE_BATCH}쪽씩 묶어 뷰어에 묻는다(쪽마다 SVG 가 수백 KB — 메시지 하나가 너무 커지지 않게)`, async () => {
    expect(PAGE_BATCH).toBe(20);
    await openCopy('outline-demo.hwpx', '개요.hwpx');

    await exportPdf({ pages: '1-3' });

    expect(pageRequests().map((request) => request.params.pages)).toEqual([[0, 1, 2]]);
  });

  it('경로 규칙이 save_document 와 같다: 겹치면 번호, 상대 경로는 원본 폴더, 확장자, 덮어쓰기, 한글 문서 경로 거부', async () => {
    // AC-5
    const source = await openCopy('notice.hwpx', '공문.hwpx');

    expect((await exportPdf()).path).toBe(join(dir, '공문.pdf'));
    expect((await exportPdf()).path).toBe(join(dir, '공문-2.pdf'));
    expect((await exportPdf({ path: '회신' })).path).toBe(join(dir, '회신.pdf'));
    expect(await exportError({ path: '회신.pdf' })).toBe(`이미 있는 파일입니다: ${join(dir, '회신.pdf')}. 덮어쓰려면 overwrite: true 를 주세요.`);
    await writeFile(join(dir, '회신.pdf'), '옛 PDF');
    expect((await exportPdf({ path: '회신.pdf', overwrite: true })).path).toBe(join(dir, '회신.pdf'));
    expect((await readFile(join(dir, '회신.pdf'))).subarray(0, 5).toString()).toBe('%PDF-');
    expect(await exportError({ path: '회신.docx' })).toBe('PDF 로만 내보냅니다(.docx). 경로를 .pdf 로 끝내거나 확장자를 빼세요.');
    expect(await exportError({ path: source, overwrite: true })).toBe('한글 문서(.hwpx) 경로에는 PDF 를 쓰지 않습니다. 경로를 .pdf 로 끝내세요.');
    expect((await readFile(source)).equals(await readFile(fixturePath('notice.hwpx')))).toBe(true);
  });

  it('저장 전 새 문서는 create_document 경로 옆 <이름>.pdf, 상대 경로는 그 폴더 기준', async () => {
    await json('create_document', { path: join(dir, '제안서.hwpx') });

    expect((await exportPdf()).path).toBe(join(dir, '제안서.pdf'));
    expect((await exportPdf({ path: '사본' })).path).toBe(join(dir, '사본.pdf'));
  });

  it('내보내기는 편집이 아니다: 되돌리기 칸·저장하지 않은 편집 수가 그대로이고, 저장 전 편집이 있으면 warnings 로 알린다', async () => {
    // AC-6
    await openCopy('notice.hwpx', '공문.hwpx');
    expect((await exportPdf()).warnings).toBeUndefined();
    await json('replace_text', { target: { id: 'b1' }, text: '안내 제목' }); // 시험 글꼴에 있는 글자로
    const editRequests = () => viewer.history.filter((request) => request.method === 'edit' || request.method === 'undo').length;
    const edits = editRequests();

    const result = await exportPdf();

    expect(result.warnings).toEqual([unsavedEditsWarning(1)]);
    expect(unsavedEditsWarning(1)).toBe('저장하지 않은 편집 1개가 PDF 에 들어갔습니다(HWPX 는 아직 저장 전)');
    expect(await pdfText(result.path)).toContain('안내제목');
    expect(editRequests()).toBe(edits);
    expect(await unsavedEdits()).toBe(1);
    expect(sessions.get().editCount).toBe(1);
    // 되돌리면 내보내기 전 편집이 되돌아간다(내보내기가 칸을 차지하지 않는다)
    expect(await json('undo', {})).toMatchObject({ undone: 1 });
    expect(sessions.get().editCount).toBe(0);
  });

  it('클라이언트가 진행 알림을 받으면(progressToken) 쪽 묶음을 그릴 때마다와 PDF 쓰기 전에 알린다 — total = 쪽 수 + 1(쓰기 한 단계)', async () => {
    await openCopy('outline-demo.hwpx', '개요.hwpx');
    const progress: Array<{ progress: number; total?: number; message?: string }> = [];

    await client.callTool({ name: 'export_pdf', arguments: {} }, undefined, { onprogress: (event) => progress.push(event) });

    expect(progress).toEqual([
      { progress: 3, total: 4, message: '쪽 3/3 그림' },
      { progress: 4, total: 4, message: 'PDF 쓰는 중' },
    ]);
  });

  it(`묶음이 여럿이면(${PAGE_BATCH}쪽 넘게) 묶음마다 알리고 progress 는 알림마다 늘어난다(MCP 규격 MUST)`, async () => {
    // 개요 문서(3쪽)를 45쪽 문서인 척: 열 때 쪽 수를 45 로, 쪽은 쪽 번호 % 3
    const handle = rhwpViewerHandler();
    const realPages = openFixture('outline-demo.hwpx').pageCount();
    viewer.serve((request) => {
      if (request.method === 'export_pdf_pages') return handle({ ...request, params: { pages: request.params.pages.map((page) => page % realPages) } });
      const result = handle(request);
      return request.method === 'load_document' && typeof result === 'object' && result !== null ? { ...result, pageCount: 45 } : result;
    });
    await openCopy('outline-demo.hwpx', '개요.hwpx');
    const progress: Array<{ progress: number; total?: number; message?: string }> = [];

    const result = toolResultSchema.parse(await client.callTool({ name: 'export_pdf', arguments: {} }, undefined, { onprogress: (event) => progress.push(event) }));

    expect(result.isError).toBeUndefined();
    expect(pageRequests().map((request) => request.params.pages.length)).toEqual([20, 20, 5]);
    expect(progress).toEqual([
      { progress: 20, total: 46, message: '쪽 20/45 그림' },
      { progress: 40, total: 46, message: '쪽 40/45 그림' },
      { progress: 45, total: 46, message: '쪽 45/45 그림' },
      { progress: 46, total: 46, message: 'PDF 쓰는 중' },
    ]);
    for (const [i, event] of progress.entries()) if (i > 0) expect(event.progress).toBeGreaterThan(progress[i - 1]?.progress ?? Infinity);
    expect((await inspectPdf(new Uint8Array(await readFile(join(dir, '개요.pdf'))))).pages).toHaveLength(45);
  });

  it('AC-7 뷰어 PDF 버튼 요청(user_export_pdf)은 기본 경로에 PDF 를 저장하고 그 경로를 돌려준다 — 편집이 아니다', async () => {
    await openCopy('notice.hwpx', '공문.hwpx');

    const first = await viewer.userRequest('user_export_pdf', {});
    const second = await viewer.userRequest('user_export_pdf', {});

    expect(first).toMatchObject({ ok: true, result: { path: join(dir, '공문.pdf') } });
    expect(second).toMatchObject({ ok: true, result: { path: join(dir, '공문-2.pdf') } });
    expect((await readFile(join(dir, '공문.pdf'))).subarray(0, 5).toString()).toBe('%PDF-');
    expect(await unsavedEdits()).toBe(0);
    expect(sessions.get().editCount).toBe(0);
  });

  it('AC-7 PDF 버튼 요청이 실패하면 사람용 문구로 알린다 — 폴더에 쓸 수 없으면 쓰기 실패 문구, 그 밖은 일반 문구(원래 오류 문구는 보내지 않는다)', async () => {
    await openCopy('notice.hwpx', '공문.hwpx');
    await chmod(dir, 0o555);
    try {
      expect(await viewer.userRequest('user_export_pdf', {})).toEqual({
        type: 'user_response',
        id: expect.any(Number),
        ok: false,
        code: 'export_write_failed',
        error: '문서 폴더에 PDF 를 쓰지 못했습니다. 폴더에 쓸 수 있는지 확인하거나, Claude 에게 다른 경로로 저장해 달라고 하세요.',
      });
    } finally {
      await chmod(dir, 0o755);
    }

    const handle = rhwpViewerHandler();
    viewer.serve((request) => {
      if (request.method === 'export_pdf_pages') throw new Error('rhwp 원문 오류: renderPageSvg');
      return handle(request);
    });
    expect(await viewer.userRequest('user_export_pdf', {})).toMatchObject({
      ok: false,
      code: 'export_failed',
      error: 'PDF 를 만들지 못했습니다. 다시 해 주세요. 계속 안 되면 Claude 에게 PDF 로 저장해 달라고 하세요.',
    });
  });

  it('뷰어가 연결되지 않았으면 기존 "뷰어가 없습니다" 오류', async () => {
    const source = await openCopy('notice.hwpx', '공문.hwpx');
    viewer.close();
    await new Promise((resolve) => bridge.events.once('disconnected', resolve));

    expect(await exportError()).toBe(`뷰어가 연결되어 있지 않습니다. open_document 로 다시 여세요. 마지막 파일: ${source}`);
  });
});
