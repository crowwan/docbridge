// SPEC-008 export_pdf 큰 문서 메모리 측정(#114, ADR 005): 실제 서버 프로세스(node src/server/index.ts)를 띄워 MCP 로 export_pdf 를 부르고,
// 그 프로세스의 RSS 를 ps 로 잰다 — rhwp 문서·쪽 SVG 만들기는 이 측정 프로세스(가짜 뷰어)에만 있고 서버에는 없다(실제와 같다).
// 큰 문서는 문서 쪽을 되풀이해 N쪽인 척한다(load_document 쪽 수를 N 으로, export_pdf_pages 는 쪽 번호 % 실제 쪽 수).
// 실행: node scripts/measure-pdf-server.ts [문서 경로] [--pages N] [--max-old-space MB]   (경로가 없으면 fixtures/notice.hwpx, N 기본 300)
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { pdfPages, type PdfPage } from '../src/core/pdf-pages.ts';
import { openDocumentFile } from '../src/core/rhwp-node.ts';
import { FakeViewer } from '../tests/fake-viewer.ts';
import { rhwpViewerHandler } from '../tests/rhwp-viewer.ts';

const MB = 1024 * 1024;
const run = promisify(execFile);
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const bigPages = Number(flag('--pages') ?? 300);
/** 서버 힙 상한(MB) — 주면 그 상한 안에서 끝나는지(살아 있는 메모리가 그보다 작은지) 본다 */
const heapLimit = flag('--max-old-space');
const flagValues = new Set(['--pages', '--max-old-space'].map((name) => args.indexOf(name) + 1).filter((at) => at > 0));
const source = args.find((arg, i) => !arg.startsWith('--') && !flagValues.has(i)) ?? fileURLToPath(new URL('../fixtures/notice.hwpx', import.meta.url));
const toolResultSchema = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })), isError: z.boolean().optional() });
const exportSchema = z.object({ path: z.string(), pageCount: z.number(), bytes: z.number() });

// 쪽 SVG·글자 배치는 미리 다 만들어 둔다(뷰어가 하는 일 — 서버 측정에 섞이지 않게)
const doc = openDocumentFile(source);
const realPages: PdfPage[] = pdfPages(doc, Array.from({ length: doc.pageCount() }, (_, page) => page));
doc.free();

const work = await mkdtemp(join(tmpdir(), 'docbridge-measure-pdf-'));
const emptyPath = join(work, 'empty-path');
await mkdir(emptyPath);
const documentPath = join(work, `문서${extname(source)}`);
await copyFile(source, documentPath);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [...(heapLimit === undefined ? [] : [`--max-old-space-size=${heapLimit}`]), fileURLToPath(new URL('../src/server/index.ts', import.meta.url))],
  // 브라우저를 열지 않게 PATH 를 빈 폴더로, 빈 포트
  env: { ...getDefaultEnvironment(), PATH: emptyPath, DOCBRIDGE_PORT: '0' },
  stderr: 'pipe',
});
const stderr = transport.stderr;
if (!(stderr instanceof PassThrough)) throw new Error('stderr 를 읽을 수 없습니다');
const viewerUrl = new Promise<string>((resolve) => {
  let output = '';
  stderr.on('data', (chunk: Buffer) => {
    output += String(chunk);
    const url = /뷰어 주소: (\S+)/.exec(output)?.[1];
    if (url !== undefined) resolve(url);
  });
});
const client = new Client({ name: 'docbridge-measure', version: '0.0.0' });
await client.connect(transport);
const viewer = await FakeViewer.connect(await viewerUrl);
const handle = rhwpViewerHandler();
viewer.serve((request) => {
  if (request.method === 'export_pdf_pages') {
    return { pages: request.params.pages.map((page) => realPages[page % realPages.length]), screenFonts: {} };
  }
  const result = handle(request);
  // 열 때 쪽 수만 N 으로(쪽 범위 검사가 N 쪽 문서로 하게)
  if (request.method === 'load_document' && typeof result === 'object' && result !== null) return { ...result, pageCount: bigPages };
  return result;
});

const pid = transport.pid;
if (pid === null) throw new Error('서버 pid 를 모릅니다');
/** 서버 프로세스 RSS(MB) — ps 는 KB 로 준다 */
const rss = async () => Number((await run('ps', ['-o', 'rss=', '-p', String(pid)])).stdout.trim()) / 1024;

/** run 하는 동안 서버 RSS 를 50ms 마다 재서 가장 큰 값 */
async function sampled<T>(work: () => Promise<T>): Promise<{ value: T; ms: number; peakMb: number }> {
  let peak = await rss();
  let done = false;
  const sampler = (async () => {
    while (!done) {
      peak = Math.max(peak, await rss());
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
  const started = performance.now();
  const value = await work();
  const ms = performance.now() - started;
  done = true;
  await sampler;
  return { value, ms, peakMb: peak };
}

const call = async (name: string, toolArgs: Record<string, unknown>) => {
  const result = toolResultSchema.parse(await client.callTool({ name, arguments: toolArgs }, undefined, { timeout: 600_000 }));
  if (result.isError === true) throw new Error(result.content[0]?.text);
  return JSON.parse(result.content[0]?.text ?? '');
};

try {
  await call('open_document', { path: documentPath });
  const idleMb = await rss();
  for (const label of ['처음(글꼴 훑기·읽기 포함)', '다음']) {
    const exported = await sampled(async () => exportSchema.parse(await call('export_pdf', { overwrite: true, path: join(work, '내보내기.pdf') })));
    console.log(
      JSON.stringify({
        doc: `${basename(source)} ×${bigPages}쪽`,
        run: label,
        pdfMb: Number((exported.value.bytes / MB).toFixed(1)),
        ms: Math.round(exported.ms),
        msPerPage: Number((exported.ms / bigPages).toFixed(1)),
        serverIdleMb: Math.round(idleMb),
        serverPeakMb: Math.round(exported.peakMb),
        serverAfterMb: Math.round(await rss()),
      }),
    );
  }
} finally {
  viewer.close();
  await client.close();
  await rm(work, { recursive: true, force: true });
}
