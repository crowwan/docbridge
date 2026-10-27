// SPEC-002 기술 검증(#18) 측정: 문단 옮기기 사본 비용, 스냅샷 20개 메모리·시간, 블록 다시 뽑기, HWPX 내보내기·다시 열어 비교.
// 실행: node scripts/measure-edits.ts [문서 경로 …]   (경로가 없으면 fixtures 5개)
// 메모리는 문서마다 새 프로세스에서 WASM 선형 메모리 증가로 잰다(WASM 메모리는 줄지 않아서).
// Node 는 글자 폭을 근사하므로 쪽 수·조판 시간은 브라우저와 다르다(ADR 001). 편집·직렬화 비용 비교용이다.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HwpDocument } from '@rhwp/core';
import { extractBlocks } from '../src/core/blocks.ts';
import { moveParagraphs } from '../src/core/edits.ts';
import { exportVerifiedHwpx } from '../src/core/hwpx-export.ts';
import { openDocumentFile, wasmMemoryBytes } from '../src/core/rhwp-node.ts';

const SNAPSHOTS = 20;
const MB = 1024 * 1024;

function timed<T>(run: () => T): [T, number] {
  const start = performance.now();
  const value = run();
  return [value, performance.now() - start];
}

/** 문서 하나를 재고 JSON 한 줄로 낸다 */
function measureOne(path: string): void {
  const [doc, openMs] = timed(() => openDocumentFile(path));
  const [blocks, extractMs] = timed(() => extractBlocks(doc));
  const blocksJsonKb = Buffer.byteLength(JSON.stringify(blocks)) / 1024;

  const [hwp, exportHwpMs] = timed(() => doc.exportHwp());
  const [copy, copyParseMs] = timed(() => new HwpDocument(hwp));
  copy.free();

  // 옮기기: 가운데쯤 문단 하나를 둘째 문단 앞으로(첫 문단 앞은 구역 정의 때문에 막혀 있다). 거부되면 다음 문단
  const count = doc.getParagraphCount(0);
  let moveMs: number | undefined;
  for (let p = Math.max(2, Math.floor(count / 2)); p < count && moveMs === undefined; p += 1) {
    const [result, ms] = timed(() => moveParagraphs(doc, 0, p, p + 1, 1));
    if (result.ok) moveMs = ms;
  }

  const memoryBefore = wasmMemoryBytes();
  const [snapshots, snapshotMs] = timed(() => Array.from({ length: SNAPSHOTS }, () => doc.saveSnapshot()));
  const snapshotMemoryMb = (wasmMemoryBytes() - memoryBefore) / MB;
  const first = snapshots[0] ?? 0;
  const [, restoreMs] = timed(() => doc.restoreSnapshot(first));
  for (const id of snapshots) doc.discardSnapshot(id);

  const [verified, verifyMs] = timed(() => exportVerifiedHwpx(doc));
  console.log(
    JSON.stringify({
      name: basename(path),
      pages: doc.pageCount(),
      paragraphs: count,
      blocks: blocks.length,
      bytesKb: hwp.length / 1024,
      openMs,
      extractMs,
      blocksJsonKb,
      exportHwpMs,
      copyParseMs,
      moveMs,
      snapshotMs,
      snapshotMemoryMb,
      restoreMs,
      hwpxKb: verified.bytes.length / 1024,
      ...verified.timings,
      verifyMs,
      different: verified.different.length,
      losses: verified.losses.length,
      wasmMemoryMb: wasmMemoryBytes() / MB,
    }),
  );
}

const fmt = (value: unknown) => (typeof value === 'number' ? (Number.isInteger(value) ? String(value) : value.toFixed(1)) : String(value ?? '-'));

function main(paths: string[]): void {
  const columns = [
    ['name', '문서'],
    ['pages', '쪽(Node 근사)'],
    ['paragraphs', '문단'],
    ['blocks', '블록'],
    ['extractMs', '블록 뽑기'],
    ['blocksJsonKb', '블록 JSON KB'],
    ['exportHwpMs', '사본 exportHwp'],
    ['copyParseMs', '사본 열기'],
    ['moveMs', '옮기기 전체'],
    ['snapshotMs', `스냅샷 ${SNAPSHOTS}개`],
    ['snapshotMemoryMb', `스냅샷 ${SNAPSHOTS}개 메모리 MB`],
    ['restoreMs', '되돌리기 1번'],
    ['exportMs', 'HWPX 내보내기'],
    ['reopenMs', '다시 열기'],
    ['compareMs', '블록 비교'],
    ['hwpxKb', 'HWPX KB'],
    ['different', '다른 블록'],
    ['losses', '손실'],
  ] as const;
  console.log(`| ${columns.map(([, label]) => label).join(' | ')} |`);
  console.log(`|${columns.map(() => '---').join('|')}|`);
  for (const path of paths) {
    const output = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--one', path], { encoding: 'utf8' });
    const row: Record<string, unknown> = JSON.parse(output.trim().split('\n').at(-1) ?? '{}');
    console.log(`| ${columns.map(([key]) => fmt(row[key])).join(' | ')} |`);
  }
}

const [flag, one] = process.argv.slice(2);
if (flag === '--one' && one !== undefined) {
  measureOne(one);
} else {
  const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
  const given = process.argv.slice(2);
  main(given.length > 0 ? given : readdirSync(fixtures).filter((f) => /\.hwpx?$/.test(f)).map((f) => fixtures + f));
}
