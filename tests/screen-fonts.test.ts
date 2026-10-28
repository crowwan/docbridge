// SPEC-008 화면 글꼴 맞추기(PR #112 리뷰 4): 뷰어가 Canvas 로 브라우저가 실제로 쓰는 글꼴 이름을 재서 보내고, 서버는 그 이름으로 고른다.
// 글자 폭 재기는 흉내(measure 주입)로 — 브라우저 없이 같은 규칙을 본다.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { svgPagesToPdf } from '../src/core/pdf-export.ts';
import { fontLibraryFromFiles } from '../src/core/pdf-fonts-node.ts';
import { screenFontFor, screenFonts, svgFontStacks } from '../src/core/screen-fonts.ts';

const fontPath = (name: string) => fileURLToPath(new URL(`./fonts/${name}`, import.meta.url));
const REGULAR = fontPath('NotoSansKR-test.ttf');
const BOLD_ASCII = fontPath('NotoSansKR-bold-ascii-test.ttf');

/** installed 에 있는 글꼴만 있는 브라우저 흉내: 차례에서 있는 첫 글꼴, 없으면 끝(일반 글꼴)로 재고 글꼴마다 폭이 다르다 */
function fakeMeasure(installed: string[]): (font: string, text: string) => number {
  return (font, text) => {
    const names = (/^\S+ (.*)$/.exec(font)?.[1] ?? '').split(',').map((name) => name.trim().replace(/^"|"$/g, ''));
    const used = names.find((name) => installed.includes(name)) ?? names[names.length - 1] ?? '';
    return text.length * (used.length + (installed.indexOf(used) + 1) * 100);
  };
}

describe('SPEC-008 화면 글꼴 맞추기', () => {
  it('SVG 의 font-family 차례들을 한 번씩 모은다(글자 참조 풀기)', () => {
    const svg =
      '<svg><text font-family="&apos;휴먼명조&apos;,&apos;Nanum Myeongjo&apos;,serif">가</text>' +
      '<text font-family="&apos;휴먼명조&apos;,&apos;Nanum Myeongjo&apos;,serif">나</text><text font-family="Arial">A</text></svg>';

    expect(svgFontStacks([svg])).toEqual([
      ['휴먼명조', 'Nanum Myeongjo', 'serif'],
      ['Arial'],
    ]);
  });

  it('차례에서 브라우저에 있는 첫 글꼴 이름을 고른다(없는 글꼴은 일반 글꼴과 폭이 같다)', () => {
    const measure = fakeMeasure(['Nanum Myeongjo', 'AppleMyungjo']);

    expect(screenFontFor(['휴먼명조', 'Nanum Myeongjo', 'AppleMyungjo', 'serif'], measure)).toBe('Nanum Myeongjo');
    expect(screenFontFor(['휴먼명조', 'serif'], measure)).toBeUndefined();
  });

  it('차례마다 실제 글꼴 이름 표(열쇠 = 이름을 쉼표로 이은 것), 찾지 못한 차례는 빠진다', () => {
    const svg = '<svg><text font-family="&apos;휴먼명조&apos;,&apos;Nanum Myeongjo&apos;,serif">가</text><text font-family="Unknown,serif">A</text></svg>';

    expect(screenFonts([svg], fakeMeasure(['Nanum Myeongjo']))).toEqual({ '휴먼명조,Nanum Myeongjo,serif': 'Nanum Myeongjo' });
  });

  it('서버는 화면 글꼴 이름을 차례 맨 앞에 두고 고른다', async () => {
    // 차례는 "Bold Face" 가 앞이지만 화면(브라우저)은 "Regular Face" 를 썼다(시험 글꼴 둘은 이름이 같아 이름을 바꿔 둔다)
    const files = await fontLibraryFromFiles([BOLD_ASCII, REGULAR], { serif: [], 'sans-serif': [], fallback: [] });
    const renamed = ['Bold Face', 'Regular Face'];
    const library = { ...files, faces: files.faces.map((face, i) => ({ ...face, families: [renamed[i] ?? ''] })) };
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text x="10" y="50" font-size="20" font-family="'Bold Face','Regular Face'">A</text></svg>`;
    const stack = 'Bold Face,Regular Face';

    const withoutScreen = await svgPagesToPdf([{ svg }], library);
    const withScreen = await svgPagesToPdf([{ svg }], library, { screenFonts: { [stack]: 'Regular Face' } });

    expect(withoutScreen.stats.fonts).toEqual([`${BOLD_ASCII}#0`]);
    expect(withScreen.stats.fonts).toEqual([`${REGULAR}#0`]);
    expect(withScreen.warnings).toEqual([]);
  });

  it('화면 글꼴을 서버 글꼴에서 찾지 못하면 다른 글꼴로 그리고 warnings 로 알린다', async () => {
    const library = await fontLibraryFromFiles([REGULAR], { serif: [], 'sans-serif': ['Noto Sans KR'], fallback: [] });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text x="10" y="50" font-size="20" font-family="&apos;나눔명조&apos;,sans-serif">가</text></svg>';

    const { warnings, stats } = await svgPagesToPdf([{ svg }], library, { screenFonts: { '나눔명조,sans-serif': '나눔명조' } });

    expect(stats.missingGlyphs).toBe(0);
    expect(warnings).toEqual(['화면 글꼴 "나눔명조" 를 이 컴퓨터 글꼴에서 쓸 수 없음(다른 글꼴로 그림) 1곳']);
  });
});
