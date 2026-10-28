// SPEC-008 서버 글꼴 읽기(PR #112 리뷰): 비동기 읽기와 글꼴 바이트 캐시 한도.
// 시험 글꼴(tests/fonts/, Noto Sans KR 부분 집합, OFL)만 쓴다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FONT_CACHE_BYTES, FontBytesCache, fontEntries, fontLibraryFromFiles } from '../src/core/pdf-fonts-node.ts';

const fontPath = (name: string) => fileURLToPath(new URL(`./fonts/${name}`, import.meta.url));
const REGULAR = fontPath('NotoSansKR-test.ttf');
const BOLD_ASCII = fontPath('NotoSansKR-bold-ascii-test.ttf');
const generic = { serif: [], 'sans-serif': [], fallback: [] };

describe('SPEC-008 서버 글꼴 읽기', () => {
  it('글꼴 목록 읽기는 비동기라 읽는 사이 다른 일(이벤트 루프)이 돈다', async () => {
    let ticked = false;
    setImmediate(() => {
      ticked = true;
    });
    // 같은 파일 여러 개(파일마다 열고 머리를 읽는다)
    const entries = await fontEntries(Array.from({ length: 40 }, () => REGULAR));

    expect(entries).toHaveLength(40);
    expect(ticked).toBe(true);
  });

  it('읽지 못하는 파일은 건너뛰고 파일 차례대로 글꼴 목록을 만든다', async () => {
    const entries = await fontEntries([BOLD_ASCII, fontPath('없는-글꼴.ttf'), REGULAR]);

    expect(entries.map((entry) => entry.weight)).toEqual([700, 400]);
    expect(entries.map((entry) => entry.id)).toEqual([`${BOLD_ASCII}#0`, `${REGULAR}#0`]);
  });

  it('글꼴 바이트는 처음 쓸 때 한 번만 읽고, 다음에는 캐시에서 준다', async () => {
    const cache = new FontBytesCache();
    const library = await fontLibraryFromFiles([REGULAR], generic, cache);
    const id = `${REGULAR}#0`;

    const [first, second] = await Promise.all([library.load(id), library.load(id)]);
    expect(first).toBe(second);
    expect(await library.load(id)).toBe(first);
    expect(cache.bytes).toBe(readFileSync(REGULAR).length);
  });

  it('캐시는 바이트 합이 한도를 넘으면 가장 오래 안 쓴 글꼴부터 버린다', () => {
    const cache = new FontBytesCache(10);
    cache.set('a', new Uint8Array(4));
    cache.set('b', new Uint8Array(4));
    // a 를 쓰면 b 가 가장 오래 안 쓴 것이 된다
    cache.get('a');
    cache.set('c', new Uint8Array(4));

    expect(cache.ids).toEqual(['a', 'c']);
    expect(cache.bytes).toBe(8);
    // 한도보다 큰 것은 두지 않는다
    cache.set('big', new Uint8Array(11));
    expect(cache.ids).toEqual(['a', 'c']);
  });

  it('버린 글꼴은 다음에 디스크에서 다시 읽는다', async () => {
    const size = readFileSync(REGULAR).length;
    const cache = new FontBytesCache(size + 1);
    const library = await fontLibraryFromFiles([REGULAR, BOLD_ASCII], generic, cache);
    const regular = await library.load(`${REGULAR}#0`);
    await library.load(`${BOLD_ASCII}#0`);

    expect(cache.ids).toEqual([`${BOLD_ASCII}#0`]);
    const again = await library.load(`${REGULAR}#0`);
    expect(again).not.toBe(regular);
    expect(again).toEqual(regular);
  });

  it('서버 캐시 한도는 96MB(실제 공고문이 쓴 글꼴 74.3MB 가 들어간다 — ADR 005)', () => {
    expect(FONT_CACHE_BYTES).toBe(96 * 1024 * 1024);
  });
});
