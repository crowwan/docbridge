// 화면(브라우저)이 실제로 쓰는 글꼴 이름 — PDF 내보내기(SPEC-008, PR #112 리뷰 4).
// 서버가 시스템 글꼴 폴더를 훑어 브라우저처럼 고르지만, 폴더를 빠뜨리거나(맥 AssetsV2) 플랫폼 차이로 다를 수 있다.
// 그래서 뷰어가 SVG font-family 차례마다 브라우저가 실제로 쓰는 첫 글꼴을 Canvas 글자 폭으로 재서 보내고, 서버는 그 이름을 맨 앞에 두고 고른다.
// 여기는 DOM 없는 규칙(글자 폭 재기는 부르는 쪽이 준다 — 뷰어는 Canvas measureText).
import { decodeEntities, parseFontFamilies } from './pdf-svg.ts';

/** 글자 폭 재기(CSS font 글, 글자 → 폭) */
export type MeasureText = (font: string, text: string) => number;

/** 차례 → 표 열쇠(이름을 쉼표로 이은 것 — 서버도 같은 열쇠로 찾는다) */
export const fontStackKey = (families: string[]): string => families.join(',');

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);
/** 있는지 볼 때 견줄 일반 글꼴(없는 글꼴이면 이 글꼴로 재져 폭이 같다). 셋 다 같을 때만 없다고 본다 */
const PROBE_BASES = ['monospace', 'serif', 'sans-serif'];
/** 한글·로마자·숫자·기호를 섞어 글꼴마다 폭이 달라지게 */
const PROBE_TEXT = '가나다라마 한글 글꼴 mmmmmwwiill 0123456789 ∙⇨①';
const PROBE_SIZE = '72px';

const FONT_FAMILY = /font-family="([^"]*)"/g;

/** 쪽 SVG 들의 font-family 차례들(같은 차례는 한 번) */
export function svgFontStacks(svgs: string[]): string[][] {
  const stacks = new Map<string, string[]>();
  for (const svg of svgs) {
    for (const match of svg.matchAll(FONT_FAMILY)) {
      const families = parseFontFamilies(decodeEntities(match[1] ?? ''));
      if (families.length > 0) stacks.set(fontStackKey(families), families);
    }
  }
  return [...stacks.values()];
}

const quoted = (name: string): string => `"${name.replace(/"/g, '\\"')}"`;

/** 차례에서 이 브라우저에 있는 첫 글꼴 이름. 있는 것이 없으면(일반 글꼴로 그림) undefined */
export function screenFontFor(families: string[], measure: MeasureText): string | undefined {
  return families.find((name) => {
    if (GENERIC.has(name)) return false;
    return PROBE_BASES.some((base) => measure(`${PROBE_SIZE} ${quoted(name)}, ${base}`, PROBE_TEXT) !== measure(`${PROBE_SIZE} ${base}`, PROBE_TEXT));
  });
}

/** 쪽 SVG 들의 차례마다 화면 글꼴 이름(열쇠 = fontStackKey). 찾지 못한 차례는 넣지 않는다 */
export function screenFonts(svgs: string[], measure: MeasureText): Record<string, string> {
  const fonts: Record<string, string> = {};
  for (const families of svgFontStacks(svgs)) {
    const used = screenFontFor(families, measure);
    if (used !== undefined) fonts[fontStackKey(families)] = used;
  }
  return fonts;
}
