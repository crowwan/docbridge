// 설치판(.mcpb) 검사(SPEC-004 AC-1·2·3). npm run test:pack 으로 돈다(먼저 npm run pack 으로 파일을 만든다).
// .mcpb 를 node_modules 없는 임시 폴더에 풀어, Claude Desktop 처럼 node server/index.js 로 띄우고 MCP 클라이언트로 쓴다.
import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openDocumentFile } from '../../src/core/rhwp-node.ts';
import { compact, inspectPdf } from '../../scripts/pdf-check/inspect.ts';
import { mcpbCommand, mcpbPath, NODE_RUNTIME, oneLine, packageVersion, REPO_ROOT, registeredTools } from '../../scripts/pack/manifest.ts';
import { FakeViewer } from '../fake-viewer.ts';
import { fixturePath } from '../fixtures.ts';
import { rhwpViewerHandler } from '../rhwp-viewer.ts';

const run = promisify(execFile);
const mcpb = (args: string[]) => {
  const { command, args: commandArgs } = mcpbCommand(args);
  return run(command, commandArgs);
};
const dependenciesSchema = z.object({ dependencies: z.record(z.string(), z.string()) });

const manifestSchema = z.object({
  manifest_version: z.string(),
  name: z.string(),
  version: z.string(),
  server: z.object({
    type: z.string(),
    entry_point: z.string(),
    mcp_config: z.object({ command: z.string(), args: z.array(z.string()) }),
  }),
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
  compatibility: z.object({ platforms: z.array(z.string()), runtimes: z.object({ node: z.string() }) }),
});
const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});
const openResultSchema = z.object({ doc: z.string(), fileName: z.string(), blockCount: z.number() });
const readResultSchema = z.object({ blocks: z.array(z.object({ id: z.string(), text: z.string().optional() })) });
const saveResultSchema = z.object({ path: z.string(), bytes: z.number(), verified: z.object({ blockCount: z.number() }) });
const exportResultSchema = z.object({ path: z.string(), pageCount: z.number(), bytes: z.number(), warnings: z.array(z.string()).optional() });

/** 서버가 stderr 에 남기는 "뷰어 주소: …" 줄에서 주소를 읽는다 */
function viewerUrlFromLog(stderr: Readable): Promise<string> {
  return new Promise((resolve) => {
    let output = '';
    const onData = (chunk: Buffer) => {
      output += String(chunk);
      const url = /뷰어 주소: (\S+)/.exec(output)?.[1];
      if (url === undefined) return;
      stderr.off('data', onData);
      resolve(url);
    };
    stderr.on('data', onData);
  });
}

describe('SPEC-004 설치판(.mcpb)', () => {
  let version: string;
  /** .mcpb 를 푼 폴더(임시 폴더라 위로 올라가도 node_modules 가 없다) */
  let extracted: string;
  let work: string;

  beforeAll(async () => {
    version = await packageVersion();
    const file = mcpbPath(version);
    await access(file).catch(() => {
      throw new Error(`${file} 이 없습니다. npm run test:pack 으로 돌리세요(먼저 npm run pack)`);
    });
    work = await mkdtemp(join(tmpdir(), 'docbridge-mcpb-'));
    extracted = join(work, 'extension');
    await mcpb(['unpack', file, extracted]);
  });

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('npm run pack 이 dist/docbridge-<버전>.mcpb 를 만들고, 그 안의 manifest 가 mcpb validate 를 통과한다', async () => {
    // AC-1
    await mcpb(['validate', join(extracted, 'manifest.json')]);

    expect((await readdir(extracted)).sort()).toEqual(['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'manifest.json', 'server', 'viewer']);
    expect(await readdir(join(extracted, 'server'))).toEqual(['index.js']);
    expect((await readdir(join(extracted, 'viewer', 'assets'))).some((name) => name.endsWith('.wasm'))).toBe(true);
    expect(await readFile(join(extracted, 'LICENSE'), 'utf8')).toContain('rhwp');
  });

  it('THIRD_PARTY_NOTICES.txt 에 package.json dependencies 패키지 전부의 라이선스가 들어 있다', async () => {
    // PR #97 리뷰: NOTICES 는 서버 번들만 보고 모은다. 뷰어에만 쓰는 의존성이 생겨 빠지면 여기서 실패한다
    const notices = await readFile(join(extracted, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    const { dependencies } = dependenciesSchema.parse(JSON.parse(await readFile(`${REPO_ROOT}package.json`, 'utf8')));

    // 지금은 @modelcontextprotocol/sdk·@rhwp/core·ws·zod
    expect(Object.keys(dependencies)).toContain('@rhwp/core');
    for (const name of Object.keys(dependencies)) expect(notices).toContain(`\n## ${name}\n\n`);
  });

  it('manifest 의 version 은 package.json 과 같고, tools 는 서버에 실제 등록된 도구 전부와 같다', async () => {
    // AC-3: 도구 목록은 서버(mcp.ts)에 물어서 비교한다 — 도구를 더하거나 빼면 다시 pack 하면 맞는다
    const manifest = manifestSchema.parse(JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8')));
    const tools = await registeredTools();

    expect(manifest.version).toBe(version);
    expect(manifest.tools).toEqual(tools.map(({ name, description }) => ({ name, description: oneLine(description) })));
    expect(manifest.tools.every(({ description }) => description.length > 0)).toBe(true);
    expect(manifest).toMatchObject({
      manifest_version: '0.3',
      name: 'docbridge',
      server: { type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] } },
      compatibility: { platforms: ['darwin', 'win32'], runtimes: { node: NODE_RUNTIME } },
    });
  });

  it('node_modules 없는 폴더에 푼 서버가 node server/index.js 로 떠서 open_document → read_blocks → save_document → export_pdf 가 된다', async () => {
    // AC-2. export_pdf(SPEC-008)는 번들에 든 pdf-lib·fontkit 과 이 컴퓨터의 시스템 글꼴로 PDF 를 만든다. 브라우저를 열지 않도록 PATH 를 빈 폴더로 둔다(브라우저 여는 명령을 찾지 못하면 stderr 에 주소만 남긴다)
    const emptyPath = join(work, 'empty-path');
    await mkdir(emptyPath);
    const documentPath = join(work, '공문.hwpx');
    await copyFile(fixturePath('notice.hwpx'), documentPath);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(extracted, 'server', 'index.js')],
      cwd: extracted,
      env: { ...getDefaultEnvironment(), PATH: emptyPath, DOCBRIDGE_PORT: '0' },
      stderr: 'pipe',
    });
    const stderr = transport.stderr;
    if (!(stderr instanceof PassThrough)) throw new Error('stderr 를 읽을 수 없습니다');
    const viewerUrl = viewerUrlFromLog(stderr);
    const client = new Client({ name: 'docbridge-pack-test', version: '0.0.0' });
    await client.connect(transport);
    const json = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const result = toolResultSchema.parse(await client.callTool({ name, arguments: args }));
      if (result.isError === true) throw new Error(result.content[0]?.text);
      return JSON.parse(result.content[0]?.text ?? '');
    };
    const viewer = await FakeViewer.connect(await viewerUrl);
    try {
      // 번들 옆 viewer/ 를 서버가 내준다(뷰어 페이지와 rhwp WASM)
      const page = await fetch(await viewerUrl);
      const wasmName = (await readdir(join(extracted, 'viewer', 'assets'))).find((name) => name.endsWith('.wasm'));
      const wasm = await fetch(new URL(`/assets/${wasmName}`, await viewerUrl));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<script');
      expect(wasm.headers.get('content-type')).toBe('application/wasm');

      viewer.serve(rhwpViewerHandler());
      const opened = openResultSchema.parse(await json('open_document', { path: documentPath }));
      const read = readResultSchema.parse(await json('read_blocks', { fromPage: 1 }));
      const saved = saveResultSchema.parse(await json('save_document', {}));

      expect(opened).toMatchObject({ doc: 'd1', fileName: '공문.hwpx' });
      expect(read.blocks).toHaveLength(opened.blockCount);
      expect(saved.path).toBe(join(work, '공문-수정.hwpx'));
      expect(saved.verified.blockCount).toBe(opened.blockCount);
      // 저장한 파일을 다시 열 수 있다
      expect(openDocumentFile(saved.path).pageCount()).toBe(1);

      // 글꼴이 없는 CI 리눅스에서도 돈다: 보이는 글자는 빠지고(warnings) 글자 층은 남아 뽑힌다 — 글꼴에 기대는 단언은 하지 않는다
      const exported = exportResultSchema.parse(await json('export_pdf', {}));
      const pdf = await inspectPdf(new Uint8Array(await readFile(exported.path)));
      expect(exported).toMatchObject({ path: join(work, '공문-수정.pdf'), pageCount: 1 });
      expect(pdf.pages).toHaveLength(1);
      expect(compact(pdf.pages[0]?.text ?? '')).toContain(compact('2026년 하반기 주민 안전교육 일정 안내'));
    } finally {
      viewer.close();
      await client.close();
    }
  });
});
