// SPEC-008 기술 검증(#107): 쪽 SVG → PDF 후보를 Chromium 안에서 재고, macOS 미리보기로 열어 볼 PDF 를 만든다(ADR 005, AC-8 수동 QA 재료).
// 뷰어처럼 브라우저(Playwright Chromium)에서 rhwp 를 띄워 Canvas 글자 폭으로 줄 배치한 쪽 SVG 를 얻고(scripts/pdf-check/browser.ts),
//   a) pdf-lib 로 SVG 직접 그리기(src/core/pdf-export.ts) — 브라우저 안 / 같은 SVG 를 Node(서버 자리)에서
//   b) jsPDF + svg2pdf.js
//   c) 그림으로 찍기(대조용, 글자 선택 불가)
// 를 만든다. 글꼴은 이 컴퓨터의 시스템 글꼴(src/core/pdf-fonts-node.ts)에서 화면과 같은 차례로 고른다.
// 만든 PDF 는 pdfjs-dist 로 글자를 뽑아 본문과 비교하고(scripts/pdf-check/inspect.ts), macOS 면 PDFKit(미리보기 엔진)으로도 뽑는다.
// 실행: node scripts/make-pdf-check.ts [출력 폴더] [--runs N] [--doc 경로]…
//   기본 출력 ~/Downloads/docbridge-pdf-check, fixture 5개 + --doc 로 준 문서(레포 밖 실제 문서는 읽기만). 결과물은 레포에 넣지 않는다.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { z } from 'zod';
import { extractBlocks } from '../src/core/blocks.ts';
import { svgPagesToPdf } from '../src/core/pdf-export.ts';
import { GENERIC_FAMILIES, systemFontLibrary } from '../src/core/pdf-fonts-node.ts';
import type { FontLibrary } from '../src/core/pdf-fonts.ts';
import { openDocumentFile } from '../src/core/rhwp-node.ts';
import { compact, inspectPdf } from './pdf-check/inspect.ts';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
const extraDocs = args.flatMap((arg, i) => (args[i - 1] === '--doc' ? [arg] : []));
const runs = Number(option('--runs') ?? '3');
const outDir = args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--runs' && args[i - 1] !== '--doc') ?? join(homedir(), 'Downloads', 'docbridge-pdf-check');
const repo = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const ORIGIN = 'http://pdf-check.local';

const documents = [
  ...['notice.hwpx', 'notice.hwp', 'application.hwpx', 'outline-demo.hwpx', 'report.hwpx'].map((name) => ({ label: name, path: repo(`fixtures/${name}`) })),
  ...extraDocs.filter((path) => existsSync(path)).map((path) => ({ label: basename(path), path })),
];

const candidateSchema = z.object({
  pdf: z.string(),
  ms: z.number(),
  fontMs: z.number(),
  fontBytes: z.number(),
  warnings: z.array(z.string()),
  missingGlyphs: z.number(),
});
const runSchema = z.object({
  pageCount: z.number(),
  openMs: z.number(),
  svgMs: z.array(z.number()),
  svgBytes: z.number(),
  svgs: z.array(z.string()),
  layouts: z.array(z.string()),
  screenPng: z.string(),
  a: candidateSchema,
  b: candidateSchema,
  c: candidateSchema,
});
type Candidate = z.infer<typeof candidateSchema>;

const median = (values: number[]): number => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** 본문 글자 묶음(문단 번호+글자, 표 칸 글자) — 원래 빈칸 그대로와 빈칸 뺀 것 */
function bodyTexts(path: string): Array<{ spaced: string; compact: string }> {
  const doc = openDocumentFile(path);
  const texts = extractBlocks(doc).flatMap((block) => {
    // 번호와 글자 사이는 빈칸 글자가 아니라 자리 띄움이다(rhwp 글자 배치에도 빈칸이 없다)
    if (block.kind === 'paragraph') return [`${block.number ?? ''}${block.text}`];
    if (block.kind === 'table') return block.cells.map((cell) => cell.text);
    return [];
  });
  doc.free();
  return texts.map((text) => ({ spaced: text.replace(/\s+/g, ' ').trim(), compact: compact(text) })).filter((text) => text.compact.length > 0);
}

/** 본문 글자 묶음이 PDF 글자에 몇 개 들어 있는지(빈칸 뺀 비교, 차례 무관) */
function foundRatio(pdfText: string, bodies: Array<{ compact: string }>): { found: number; total: number; missing: string[] } {
  const text = compact(pdfText);
  const missing = bodies.filter((body) => !text.includes(body.compact)).map((body) => body.compact.slice(0, 30));
  return { found: bodies.length - missing.length, total: bodies.length, missing: missing.slice(0, 5) };
}

/** macOS PDFKit(미리보기 엔진)이 뽑은 글자 — 빈칸은 PDFKit 이 글자 사이 거리로 넣는다 */
function pdfKitTexts(paths: string[]): Map<string, string> {
  const texts = new Map<string, string>();
  if (process.platform !== 'darwin' || paths.length === 0) return texts;
  const script = join(tmpdir(), 'docbridge-pdfkit-text.swift');
  writeFileSync(
    script,
    [
      'import PDFKit',
      'import Foundation',
      'var out: [String: String] = [:]',
      'for path in CommandLine.arguments.dropFirst() {',
      '  out[path] = PDFDocument(url: URL(fileURLWithPath: path))?.string ?? ""',
      '}',
      'FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out))',
    ].join('\n'),
  );
  const output = execFileSync('swift', [script, ...paths], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  for (const [path, text] of Object.entries(z.record(z.string(), z.string()).parse(JSON.parse(output)))) texts.set(path, text);
  return texts;
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const fontScanStarted = performance.now();
  const library = systemFontLibrary();
  const fontScanMs = performance.now() - fontScanStarted;
  console.error(`시스템 글꼴 ${library.faces.length}개 (${fontScanMs.toFixed(0)}ms)`);

  const bundle = await build({
    entryPoints: [repo('scripts/pdf-check/browser.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    logLevel: 'error',
  });
  const bundleJs = bundle.outputFiles[0]?.text ?? '';
  const wasm = readFileSync(repo('node_modules/@rhwp/core/rhwp_bg.wasm'));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><body><script type="module" src="/bundle.js"></script>' });
    if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundleJs });
    if (url.pathname === '/rhwp_bg.wasm') return route.fulfill({ contentType: 'application/wasm', body: wasm });
    if (url.pathname.startsWith('/doc/')) {
      const doc = documents[Number(url.pathname.slice(5))];
      return doc === undefined ? route.fulfill({ status: 404 }) : route.fulfill({ body: readFileSync(doc.path) });
    }
    if (url.pathname.startsWith('/font/')) {
      const bytes = await library.load(decodeURIComponent(url.pathname.slice(6)));
      return route.fulfill({ contentType: 'font/ttf', body: Buffer.from(bytes) });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => 'pdfCheck' in window);

  const faces = library.faces;
  const generic: FontLibrary['generic'] = GENERIC_FAMILIES;
  const rows: Array<Record<string, unknown>> = [];
  const written: Array<{ label: string; files: string[] }> = [];
  const pdfPaths: string[] = [];
  const pending: Array<{ index: number; label: string; bodies: ReturnType<typeof bodyTexts>; first: z.infer<typeof runSchema>; times: Record<string, number[]>; nodeMs: { cold: number; warm: number[] }; nodeBytes: number; nodeFonts: string[] }> = [];

  for (const [index, doc] of documents.entries()) {
    console.error(`${doc.label} …`);
    const times: Record<string, number[]> = { a: [], aFont: [], b: [], bFont: [], c: [], svg: [], open: [] };
    let first: z.infer<typeof runSchema> | undefined;
    for (let run = 0; run < runs; run += 1) {
      const raw: unknown = await page.evaluate(
        async ({ url, faces: list, generic: names }) => {
          const check: unknown = Reflect.get(window, 'pdfCheck');
          if (typeof check !== 'object' || check === null) throw new Error('pdfCheck 가 없습니다');
          const runFn: unknown = Reflect.get(check, 'run');
          if (typeof runFn !== 'function') throw new Error('pdfCheck.run 이 없습니다');
          return Reflect.apply(runFn, check, [url, list, names]);
        },
        { url: `/doc/${index}`, faces, generic },
      );
      const result = runSchema.parse(raw);
      first ??= result;
      times['a']?.push(result.a.ms);
      times['aFont']?.push(result.a.fontMs);
      times['b']?.push(result.b.ms);
      times['bFont']?.push(result.b.fontMs);
      times['c']?.push(result.c.ms);
      times['svg']?.push(result.svgMs.reduce((sum, ms) => sum + ms, 0));
      times['open']?.push(result.openMs);
    }
    if (first === undefined) continue;

    // 같은 SVG 를 Node(서버 자리)에서: 처음(글꼴 읽기 포함, 새 글꼴 목록) / 다시(읽어 둔 글꼴)
    const nodeLibrary = systemFontLibrary();
    const sources = first.svgs.map((svg, i) => ({ svg, textLayout: first?.layouts[i] }));
    let started = performance.now();
    const node = await svgPagesToPdf(sources, nodeLibrary);
    const cold = performance.now() - started;
    const warm: number[] = [];
    for (let run = 0; run < runs; run += 1) {
      started = performance.now();
      await svgPagesToPdf(sources, nodeLibrary);
      warm.push(performance.now() - started);
    }

    const prefix = `${String(index + 1).padStart(2, '0')}-${doc.label.replace(/\.[^.]+$/, '').replace(/[\s()]+/g, '_').slice(0, 40)}`;
    const files = {
      a: `${prefix}-a-pdflib.pdf`,
      b: `${prefix}-b-jspdf-svg2pdf.pdf`,
      c: `${prefix}-c-그림(대조용).pdf`,
      screen: `${prefix}-화면-1쪽.png`,
    };
    writeFileSync(join(outDir, files.a), Buffer.from(first.a.pdf, 'base64'));
    writeFileSync(join(outDir, files.b), Buffer.from(first.b.pdf, 'base64'));
    writeFileSync(join(outDir, files.c), Buffer.from(first.c.pdf, 'base64'));
    writeFileSync(join(outDir, files.screen), Buffer.from(first.screenPng, 'base64'));
    // --dump-svg: 브라우저가 낸 쪽 SVG·글자 배치(모양이 다를 때 원인 찾기용)
    if (args.includes('--dump-svg')) {
      first.svgs.forEach((svg, page) => writeFileSync(join(outDir, `${prefix}-${page + 1}쪽.svg`), svg));
      first.layouts.forEach((layout, page) => writeFileSync(join(outDir, `${prefix}-${page + 1}쪽-글자배치.json`), layout));
    }
    written.push({ label: doc.label, files: Object.values(files) });
    pdfPaths.push(join(outDir, files.a), join(outDir, files.b), join(outDir, files.c));
    pending.push({ index, label: doc.label, bodies: bodyTexts(doc.path), first, times, nodeMs: { cold, warm }, nodeBytes: node.bytes.length, nodeFonts: node.stats.fonts });
  }
  await browser.close();

  const kit = pdfKitTexts(pdfPaths);
  for (const item of pending) {
    const { first, bodies, times } = item;
    const prefix = `${String(item.index + 1).padStart(2, '0')}-${item.label.replace(/\.[^.]+$/, '').replace(/[\s()]+/g, '_').slice(0, 40)}`;
    const candidate = async (key: 'a' | 'b' | 'c', result: Candidate, file: string) => {
      const bytes = Buffer.from(result.pdf, 'base64');
      const inspected = await inspectPdf(new Uint8Array(bytes));
      const pdfjsText = inspected.pages.map((p) => p.text).join('\n');
      const kitText = kit.get(join(outDir, file));
      const ms = median(times[key] ?? []);
      return {
        bytes: bytes.length,
        ms: Math.round(ms),
        msPerPage: Math.round(ms / first.pageCount),
        fontMs: Math.round(median(times[`${key}Font`] ?? [0])),
        fontBytes: result.fontBytes,
        pages: inspected.pages.length,
        pageMm: inspected.pages.map((p) => `${p.widthMm.toFixed(1)}×${p.heightMm.toFixed(1)}`).filter((v, i, all) => all.indexOf(v) === i),
        embeddedFonts: inspected.embeddedFonts,
        unembeddedFonts: inspected.unembeddedFonts,
        pdfjs: foundRatio(pdfjsText, bodies),
        pdfkit: kitText === undefined ? undefined : foundRatio(kitText, bodies),
        pdfkitSpaced: kitText === undefined ? undefined : bodies.filter((body) => kitText.replace(/\s+/g, ' ').includes(body.spaced)).length,
        warnings: result.warnings,
        missingGlyphs: result.missingGlyphs,
      };
    };
    rows.push({
      document: item.label,
      pageCount: first.pageCount,
      openMs: Math.round(median(times['open'] ?? [])),
      svgMs: Math.round(median(times['svg'] ?? [])),
      svgKB: Math.round(first.svgBytes / 1024),
      a: await candidate('a', first.a, `${prefix}-a-pdflib.pdf`),
      aNode: { coldMs: Math.round(item.nodeMs.cold), warmMs: Math.round(median(item.nodeMs.warm)), bytes: item.nodeBytes, fonts: item.nodeFonts.map((id) => basename(id)) },
      b: await candidate('b', first.b, `${prefix}-b-jspdf-svg2pdf.pdf`),
      c: await candidate('c', first.c, `${prefix}-c-그림(대조용).pdf`),
    });
  }

  const measurements = { date: new Date().toISOString(), runs, platform: process.platform, node: process.version, fontScanMs: Math.round(fontScanMs), systemFaces: library.faces.length, rows };
  writeFileSync(join(outDir, 'measurements.json'), JSON.stringify(measurements, null, 2));
  writeFileSync(join(outDir, 'README.txt'), readme(written));
  console.log(JSON.stringify(measurements, null, 2));
  console.error(`→ ${outDir}`);
}

function readme(written: Array<{ label: string; files: string[] }>): string {
  return [
    'docbridge PDF 내보내기 기술 검증(#107, ADR 005) 확인 파일',
    '',
    '각 문서마다:',
    '  -a-pdflib.pdf          고른 방식(pdf-lib 로 쪽 SVG 를 직접 그림 — 글자 모양은 시스템 글꼴 윤곽, 선택·검색은 보이지 않는 글자 층)',
    '  -b-jspdf-svg2pdf.pdf   비교 후보(jsPDF + svg2pdf.js)',
    '  -c-그림(대조용).pdf     쪽을 그림으로 찍은 것(글자 선택 안 됨 — 기준 미달, 모양 비교용)',
    '  -화면-1쪽.png           뷰어 화면(rhwp Canvas, 배율 2)의 첫 쪽',
    '',
    'macOS 미리보기로 열어 확인할 것:',
    '  1. a 가 화면 PNG·c 와 같은 모양인가: 표 선·칸, 글꼴(명조/고딕), 굵게, 쪽 나눔, 글머리 점',
    '  2. a 에서 글자를 끌어 선택·복사할 수 있고, ⌘F 로 본문 낱말(예: 공고문 "청년통장", 공문 "안전교육")이 찾아지는가',
    '  3. a 를 확대(400% 이상)해도 글자 윤곽이 매끈한가(그림이 아니라 글꼴 윤곽). 글자를 끌어 고르면 파란 선택 상자가 글자 위에 맞게 덮이는가',
    '  4. 쪽 크기가 A4(210×297mm)인가 (속성 보기 또는 인쇄 미리 보기)',
    '  5. b 와 a 의 차이(글자 자리·굵게·파일 크기)',
    '',
    '다시 만들기: node scripts/make-pdf-check.ts [폴더] --doc <실제 문서 경로>',
    '',
    ...written.flatMap(({ label, files }) => [`${label}:`, ...files.map((file) => `  ${file}`)]),
    '',
  ].join('\n');
}

await main();
