// SPEC-008 export_pdf 서버 쪽 측정(#108, ADR 005 "서버에서 내보내기"): 시스템 글꼴 훑기, 처음/다음 내보내기 시간,
// 그동안 이벤트 루프가 가장 오래 멈춘 시간(MCP·뷰어 연결이 못 도는 시간), 글꼴 캐시 바이트, 큰 문서(쪽을 되풀이해 N쪽) 시간.
// 실행: node scripts/measure-pdf-export.ts [문서 경로 …] [--pages N]   (경로가 없으면 fixtures/notice.hwpx)
// 쪽 SVG·글자 배치는 Node rhwp 로 만든다(글자 폭 근사 — 줄바꿈이 브라우저와 다를 수 있다, ADR 001). 서버가 하는 일(PDF 만들기·글꼴)은 같다.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdfPages } from '../src/core/pdf-pages.ts';
import { svgPagesToPdf } from '../src/core/pdf-export.ts';
import { FontBytesCache, systemFontLibrary } from '../src/core/pdf-fonts-node.ts';
import { openDocumentFile } from '../src/core/rhwp-node.ts';

const MB = 1024 * 1024;
const args = process.argv.slice(2);
const pagesFlag = args.indexOf('--pages');
const bigPages = pagesFlag === -1 ? 300 : Number(args[pagesFlag + 1]);
const paths = args.filter((arg, i) => !arg.startsWith('--') && (pagesFlag === -1 || i !== pagesFlag + 1));
if (paths.length === 0) paths.push(fileURLToPath(new URL('../fixtures/notice.hwpx', import.meta.url)));

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** run 하는 동안 시간과 이벤트 루프 최대 멈춤(ms) */
async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number; maxBlockMs: number }> {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const started = performance.now();
  const value = await run();
  const ms = performance.now() - started;
  histogram.disable();
  return { value, ms, maxBlockMs: histogram.max / 1e6 };
}

const round = (value: number) => Math.round(value);

const cache = new FontBytesCache();
const scan = await timed(() => systemFontLibrary(cache));
const library = scan.value;
console.log(JSON.stringify({ step: '시스템 글꼴 훑기', faces: library.faces.length, ms: round(scan.ms), maxBlockMs: round(scan.maxBlockMs) }));

for (const path of paths) {
  const doc = openDocumentFile(path);
  const all = Array.from({ length: doc.pageCount() }, (_, page) => page);
  const sources = pdfPages(doc, all);
  const run = () => svgPagesToPdf(sources, library, { pause: nextTurn });
  const first = await timed(run);
  const next = await timed(run);
  console.log(
    JSON.stringify({
      doc: basename(path),
      pages: all.length,
      pdfKb: round(first.value.bytes.length / 1024),
      firstMs: round(first.ms),
      nextMs: round(next.ms),
      firstMaxBlockMs: round(first.maxBlockMs),
      nextMaxBlockMs: round(next.maxBlockMs),
      fonts: first.value.stats.fonts.length,
      cacheMb: Number((cache.bytes / MB).toFixed(1)),
      rssMb: round(process.memoryUsage().rss / MB),
    }),
  );
  // 큰 문서: 이 문서 쪽을 되풀이해 bigPages 쪽
  const big = Array.from({ length: bigPages }, (_, i) => sources[i % sources.length] ?? { svg: '', textLayout: '' });
  const large = await timed(() => svgPagesToPdf(big, library, { pause: nextTurn }));
  console.log(
    JSON.stringify({
      doc: `${basename(path)} ×${bigPages}쪽`,
      pdfMb: Number((large.value.bytes.length / MB).toFixed(1)),
      ms: round(large.ms),
      msPerPage: Number((large.ms / bigPages).toFixed(1)),
      maxBlockMs: round(large.maxBlockMs),
      rssMb: round(process.memoryUsage().rss / MB),
    }),
  );
  doc.free();
}
