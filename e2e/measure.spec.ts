// 렌더링 시간 측정(ADR 001 의 측정값). 문서마다 새 페이지로 여러 번 열어 중앙값을 낸다.
// 결과: e2e-results/metrics.json. 레포 밖 문서를 더 재려면
// DOCBRIDGE_EXTRA_FIXTURES_DIR=<폴더> DOCBRIDGE_MEASURE_EXTRA=a.hwpx,b.hwpx npm run e2e -- measure
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect, test } from '@playwright/test';
import { FIXTURES, openFixture } from './viewer.ts';

const RUNS = 5;
const extra = (process.env['DOCBRIDGE_MEASURE_EXTRA'] ?? '').split(',').filter((name) => name.length > 0);

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
const round = (value: number) => Math.round(value * 10) / 10;

interface Row {
  fixture: string;
  pages: number;
  wasmInitMs: number;
  wasmInitMaxMs: number;
  parseMs: number;
  pageRenderMedianMs: number;
  pageRenderMaxMs: number;
  totalRenderMs: number;
}

test.describe('SPEC-001 렌더링 측정 (기술 검증)', () => {
  test('문서마다 WASM 로딩·파싱·쪽 렌더링 시간을 잰다', async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const rows: Row[] = [];
    for (const fixture of [...FIXTURES, ...extra]) {
      const runs = [];
      for (let i = 0; i < RUNS; i += 1) {
        // 새 컨텍스트 = 빈 캐시에서 WASM 을 다시 받는다
        const context = await browser.newContext({ viewport: { width: 1000, height: 1200 }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        runs.push(await openFixture(page, fixture));
        await context.close();
      }
      const pageTimes = runs.flatMap((r) => r.pageRenderMs);
      rows.push({
        fixture,
        pages: runs[0]?.pageCount ?? 0,
        wasmInitMs: round(median(runs.map((r) => r.wasmInitMs))),
        wasmInitMaxMs: round(Math.max(...runs.map((r) => r.wasmInitMs))),
        parseMs: round(median(runs.map((r) => r.parseMs))),
        pageRenderMedianMs: round(median(pageTimes)),
        pageRenderMaxMs: round(Math.max(...pageTimes)),
        totalRenderMs: round(median(runs.map((r) => r.pageRenderMs.reduce((a, b) => a + b, 0)))),
      });
    }
    // 브라우저를 새로 띄워 처음 열 때(WASM 컴파일 캐시 없음)도 잰다
    const coldWasmInitMs: number[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const fresh = await chromium.launch();
      const page = await fresh.newPage({ baseURL });
      coldWasmInitMs.push(round((await openFixture(page, 'notice.hwpx')).wasmInitMs));
      await fresh.close();
    }
    await mkdir('e2e-results', { recursive: true });
    const result = { runs: RUNS, coldWasmInitMs, rows };
    await writeFile('e2e-results/metrics.json', `${JSON.stringify(result, null, 2)}\n`);
    console.log(`coldWasmInitMs ${JSON.stringify(coldWasmInitMs)}`);
    console.log(rows.map((r) => JSON.stringify(r)).join('\n'));
    expect(rows.every((r) => r.pages > 0)).toBe(true);
  });
});
