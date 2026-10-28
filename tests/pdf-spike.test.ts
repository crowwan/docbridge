// SPEC-008 PDF 로 내보내기 기술 검증(#107): rhwp 쪽 SVG → pdf-lib PDF.
// 글꼴은 레포에 넣은 시험 글꼴(Noto Sans KR 부분 집합, OFL — tests/fonts/)만 써서 컴퓨터마다 결과가 같다.
// Node 에서는 rhwp 글자 폭이 근사(rhwp-node.ts)라 줄바꿈이 브라우저와 다르지만, 글자·쪽 수·쪽 크기·글꼴 넣기는 그대로 볼 수 있다.
// 브라우저 안 시간·모양 비교는 scripts/make-pdf-check.ts(Playwright Chromium)로 잰다(ADR 005).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { HwpDocument } from '@rhwp/core';
import { extractBlocks } from '../src/core/blocks.ts';
import { svgPagesToPdf, type PdfPageSource } from '../src/core/pdf-export.ts';
import { bytesReader, extractFace, FontResolver, readCoverage, readFontFaces, type FontEntry, type FontLibrary } from '../src/core/pdf-fonts.ts';
import { fontLibraryFromFiles, systemFontDirs } from '../src/core/pdf-fonts-node.ts';
import { isElement, parseColor, parseFontFamilies, parseFontWeight, parseSvg, parseTransform, textContent, type SvgElement } from '../src/core/pdf-svg.ts';
import { compact, inspectPdf, pageContents } from '../scripts/pdf-check/inspect.ts';
import { ONE_PIXEL_PNG } from './copy-source.ts';
import { openFixture } from './fixtures.ts';

const fontPath = (name: string) => fileURLToPath(new URL(`./fonts/${name}`, import.meta.url));
const REGULAR = fontPath('NotoSansKR-test.ttf');
const BOLD_ASCII = fontPath('NotoSansKR-bold-ascii-test.ttf');
/** CFF(OpenType PostScript 윤곽) 시험 글꼴 — 맥 Apple SD Gothic Neo 처럼 */
const CFF = fontPath('NotoSansKR-cff-test.otf');
const FIXTURES = ['notice.hwpx', 'notice.hwp', 'application.hwpx', 'outline-demo.hwpx', 'report.hwpx'];

/** 시험 글꼴 하나만 있는 글꼴 목록(일반 이름도 모두 그 글꼴) */
function testLibrary(): Promise<FontLibrary> {
  return fontLibraryFromFiles([REGULAR], { serif: ['Noto Sans KR'], 'sans-serif': ['Noto Sans KR'], fallback: [] });
}

function cffLibrary(): Promise<FontLibrary> {
  return fontLibraryFromFiles([CFF], { serif: ['Noto Sans KR'], 'sans-serif': ['Noto Sans KR'], fallback: [] });
}

/** 글자마다 자리를 준 한 줄(rhwp SVG 처럼) */
function lineSvg(glyphs: Array<[string, number]>, extra = ''): string {
  const texts = glyphs.map(([char, x]) => `<text x="${x}" y="50" font-family="&apos;Noto Sans KR&apos;" font-size="20" fill="#000000"${extra}>${char}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">${texts.join('')}</svg>`;
}

/** 쪽마다 SVG + 글자 배치(뷰어가 서버로 보낼 것) */
function pageSources(doc: HwpDocument): PdfPageSource[] {
  return Array.from({ length: doc.pageCount() }, (_, page) => ({ svg: doc.renderPageSvg(page), textLayout: doc.getPageTextLayout(page) }));
}

/** 문서 본문 글자 묶음(문단 글자·번호, 표 칸 글자) — 빈칸 뺀 것 */
function bodyTexts(doc: HwpDocument): string[] {
  return extractBlocks(doc)
    .flatMap((block) => {
      if (block.kind === 'paragraph') return [`${block.number ?? ''}${block.text}`];
      if (block.kind === 'table') return block.cells.map((cell) => cell.text);
      return [];
    })
    .map(compact)
    .filter((text) => text.length > 0);
}

function elements(root: SvgElement, tag: string): SvgElement[] {
  const found: SvgElement[] = [];
  const walk = (element: SvgElement): void => {
    if (element.tag === tag) found.push(element);
    for (const child of element.children) if (isElement(child)) walk(child);
  };
  walk(root);
  return found;
}

/** 시험용 글꼴 목록 항목(이름·굵기·넣어도 되는지를 직접 정한다) */
function entry(id: string, families: string[], weight: number, embeddable = true): FontEntry {
  return { id, families, weight, italic: false, embeddable, fsType: embeddable ? 0 : 2, index: 0, postscriptName: id };
}

function libraryOf(entries: FontEntry[], files: Record<string, string>, generic: FontLibrary['generic'] = { serif: [], 'sans-serif': [], fallback: [] }): FontLibrary {
  return {
    faces: entries,
    generic,
    load: async (id) => new Uint8Array(readFileSync(files[id] ?? REGULAR)),
  };
}

/** 글꼴 둘을 모음(.ttc)으로 묶는다 — 표 위치를 모음 안 절대 위치로 다시 쓴다 */
function makeCollection(fonts: Uint8Array[]): Uint8Array {
  const headerLength = 12 + fonts.length * 4;
  const total = fonts.reduce((sum, font) => sum + font.length, headerLength);
  const out = new Uint8Array(total);
  const data = new DataView(out.buffer);
  out.set([0x74, 0x74, 0x63, 0x66], 0); // 'ttcf'
  data.setUint32(4, 0x00010000);
  data.setUint32(8, fonts.length);
  let offset = headerLength;
  fonts.forEach((font, i) => {
    data.setUint32(12 + i * 4, offset);
    out.set(font, offset);
    const numTables = new DataView(font.buffer, font.byteOffset).getUint16(4);
    for (let t = 0; t < numTables; t += 1) {
      const at = offset + 12 + t * 16 + 8;
      data.setUint32(at, data.getUint32(at) + offset);
    }
    offset += font.length;
  });
  return out;
}

describe('SPEC-008 쪽 SVG 읽기 (기술 검증)', () => {
  it('rhwp 쪽 SVG 를 요소 나무로 읽고 글자 참조(&apos; 등)를 푼다', () => {
    const svg = openFixture('notice.hwpx').renderPageSvg(0);
    const root = parseSvg(svg);

    expect(root.tag).toBe('svg');
    expect(elements(root, 'text')).toHaveLength([...svg.matchAll(/<text /g)].length);
    const first = elements(root, 'text')[0];
    expect(first === undefined ? '' : textContent(first)).toBe('가');
    expect(parseFontFamilies(first?.attrs.get('font-family'))[0]).toBe('함초롬바탕');
    expect(elements(root, 'clipPath').length).toBeGreaterThan(0);
  });

  it('transform·색·굵기를 읽는다', () => {
    expect(parseTransform('translate(10,20) scale(0.5,1)')).toEqual([0.5, 0, 0, 1, 10, 20]);
    expect(parseColor('#ff0000')).toEqual({ r: 1, g: 0, b: 0 });
    expect(parseColor('#fff')).toEqual({ r: 1, g: 1, b: 1 });
    expect(parseColor('none')).toBeUndefined();
    expect(parseColor('url(#grad)')).toBeUndefined();
    expect(parseFontWeight('bold')).toBe(700);
    expect(parseFontWeight('500')).toBe(500);
    expect(parseFontWeight(undefined)).toBe(400);
  });
});

describe('SPEC-008 PDF 글꼴 고르기 (기술 검증)', () => {
  it('글꼴 파일에서 이름·굵기·넣어도 되는지·글자 있는지를 읽는다', async () => {
    const bytes = new Uint8Array(readFileSync(REGULAR));
    const [face] = await readFontFaces(bytesReader(bytes));

    expect(face?.families).toContain('Noto Sans KR');
    expect(face?.weight).toBe(400);
    expect(face?.embeddable).toBe(true);
    const has = await readCoverage(bytes);
    expect(has('가'.codePointAt(0) ?? 0)).toBe(true);
    expect(has('A'.codePointAt(0) ?? 0)).toBe(true);
    expect(has('똠'.codePointAt(0) ?? 0)).toBe(false);
  });

  it('글꼴 모음(.ttc)에서 글꼴 하나를 떼어 내면 따로 선 글꼴로 읽힌다', async () => {
    const regular = new Uint8Array(readFileSync(REGULAR));
    const bold = new Uint8Array(readFileSync(BOLD_ASCII));
    const collection = bytesReader(makeCollection([regular, bold]));

    expect((await readFontFaces(collection)).map((face) => face.weight)).toEqual([400, 700]);
    const extracted = await extractFace(collection, 1);
    expect((await readFontFaces(bytesReader(extracted))).map((face) => face.weight)).toEqual([700]);
    expect((await readCoverage(extracted))('A'.codePointAt(0) ?? 0)).toBe(true);
    expect((await readCoverage(extracted))('가'.codePointAt(0) ?? 0)).toBe(false);
  });

  it('차례 앞 글꼴에 그 글자가 없으면 다음 글꼴에서 찾는다(브라우저 글자별 대체 글꼴처럼)', async () => {
    const resolver = new FontResolver(
      libraryOf([entry('ascii', ['Latin Only'], 400), entry('korean', ['Korean'], 400)], { ascii: BOLD_ASCII, korean: REGULAR }),
    );

    expect((await resolver.resolve(['Latin Only', 'Korean'], 400, false, 'A'))?.id).toBe('ascii');
    expect((await resolver.resolve(['Latin Only', 'Korean'], 400, false, '가'))?.id).toBe('korean');
    expect(await resolver.resolve(['Latin Only', 'Korean'], 400, false, '똠')).toBeUndefined();
  });

  it('차례에 있는 이름이 하나도 없으면 serif·sans-serif 기본 글꼴, 그다음 다른 쪽 기본 글꼴', async () => {
    const resolver = new FontResolver(
      libraryOf([entry('sans', ['Sans KR'], 400)], { sans: REGULAR }, { serif: ['Serif KR'], 'sans-serif': ['Sans KR'], fallback: [] }),
    );

    expect((await resolver.resolve(['함초롬바탕', 'serif'], 400, false, '가'))?.id).toBe('sans');
  });

  it('굵기는 CSS 규칙으로 고르고, 굵게를 바랐는데 굵은 글꼴이 없으면 합성 굵게로 표시한다', async () => {
    const faces = [entry('w300', ['F'], 300), entry('w400', ['F'], 400), entry('w700', ['F'], 700)];
    const resolver = new FontResolver(libraryOf(faces, {}));
    const pick = async (weight: number) => (await resolver.resolve(['F'], weight, false, '가'))?.id;

    expect(await pick(500)).toBe('w400');
    expect(await pick(600)).toBe('w700');
    expect(await pick(300)).toBe('w300');
    const onlyRegular = new FontResolver(libraryOf([entry('w400', ['F'], 400)], {}));
    expect(await onlyRegular.resolve(['F'], 700, false, '가')).toEqual({ id: 'w400', syntheticBold: true, syntheticItalic: false });
  });

  it('넣지 말라는(fsType Restricted) 글꼴은 고르지 않는다', async () => {
    const resolver = new FontResolver(libraryOf([entry('restricted', ['F'], 400, false), entry('open', ['G'], 400)], {}));

    expect((await resolver.resolve(['F', 'G'], 400, false, '가'))?.id).toBe('open');
  });

  it('플랫폼별 시스템 글꼴 폴더', () => {
    expect(systemFontDirs('darwin', {}, '/Users/me')).toContain('/Users/me/Library/Fonts');
    expect(systemFontDirs('win32', { WINDIR: 'C:\\Windows' }, 'C:\\Users\\me')[0]).toMatch(/Fonts$/);
    expect(systemFontDirs('linux', {}, '/home/me')).toContain('/usr/share/fonts');
  });
});

describe('SPEC-008 쪽 SVG → PDF (기술 검증)', () => {
  it.each(FIXTURES)('%s: 쪽 수가 문서와 같고 쪽 크기는 문서 쪽 설정(A4 210×297mm) 그대로다', async (name) => {
    const doc = openFixture(name);
    const { bytes, stats } = await svgPagesToPdf(pageSources(doc), await testLibrary());
    const pdf = await inspectPdf(bytes);

    expect(stats.pages).toBe(doc.pageCount());
    expect(pdf.pages).toHaveLength(doc.pageCount());
    for (const page of pdf.pages) {
      expect(page.widthMm).toBeCloseTo(210, 0);
      expect(page.heightMm).toBeCloseTo(297, 0);
    }
  });

  it.each(FIXTURES)('%s: PDF 에서 뽑은 글자에 문서 본문 글자 묶음이 차례대로 모두 들어 있다(선택·검색 가능)', async (name) => {
    const doc = openFixture(name);
    const { bytes, stats } = await svgPagesToPdf(pageSources(doc), await testLibrary());
    const text = compact((await inspectPdf(bytes)).pages.map((page) => page.text).join(''));

    expect(stats.missingGlyphs).toBe(0);
    let from = 0;
    for (const body of bodyTexts(doc)) {
      const at = text.indexOf(body, from);
      expect(at, `"${body}" 가 "${text.slice(from, from + 40)}…" 뒤에 없다`).toBeGreaterThanOrEqual(0);
      from = at + body.length;
    }
  });

  it('그림(PNG)은 PDF 그림으로 넣는다', async () => {
    const doc = openFixture('notice.hwpx');
    const last = doc.getParagraphCount(0) - 1;
    doc.insertPicture(0, last, 0, '', ONE_PIXEL_PNG, 3000, 3000, 1, 1, 'png', '그림');
    const sources = pageSources(doc);
    expect(sources.map((source) => source.svg).join('')).toContain('<image');

    const { bytes, warnings } = await svgPagesToPdf(sources, await testLibrary());
    expect(warnings).toEqual([]);
    expect(Buffer.from(bytes).toString('latin1')).toMatch(/\/Subtype\s*\/Image/);
  });

  it('투명도 0 글자(글머리 점을 원으로 그리고 숨긴 글자)는 투명하게 그려 뽑힌다', async () => {
    // rhwp 는 글머리 "·" 를 원으로 그리고 글자는 fill-opacity 0 으로 둔다(실제 공고문). 시험 글꼴에 · 가 없어 * 로 본다
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">' +
      '<circle cx="10" cy="10" r="2" fill="#000000"/><text x="8" y="14" font-size="16" fill="#000000" fill-opacity="0">*</text>' +
      '<text x="20" y="14" font-family="&apos;Noto Sans KR&apos;,sans-serif" font-size="16" fill="#000000">가</text></svg>';
    const { bytes } = await svgPagesToPdf([{ svg }], await testLibrary());

    expect(compact((await inspectPdf(bytes)).pages[0]?.text ?? '')).toBe('*가');
  });

  it('textLength 가 있으면 글자 폭을 그 폭(브라우저에서 잰 폭)에 맞춘다', async () => {
    const svg = (length: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><text x="10" y="50" font-size="20" fill="#000000"${length}>가</text></svg>`;
    const widthOf = async (length: string) => {
      const { bytes } = await svgPagesToPdf([{ svg: svg(length) }], await testLibrary());
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const doc = await getDocument({ data: bytes, verbosity: 0 }).promise;
      const item = (await (await doc.getPage(1)).getTextContent()).items[0];
      return item !== undefined && 'width' in item ? item.width : 0;
    };

    // 20px 글자 "가" 는 글꼴 폭 그대로면 0.92em = 18.4px(13.8pt), textLength 30px 이면 22.5pt
    expect(await widthOf('')).toBeCloseTo(13.8, 1);
    expect(await widthOf(' textLength="30" lengthAdjust="spacingAndGlyphs"')).toBeCloseTo(22.5, 0);
  });

  it('그러데이션은 첫 색 단색으로, 무늬·필터는 그리지 않고 warnings 로 알린다', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><defs>' +
      '<linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>' +
      '<pattern id="p" width="4" height="4"><rect width="2" height="2" fill="#000"/></pattern></defs>' +
      '<rect x="0" y="0" width="50" height="50" fill="url(#g)"/><rect x="60" y="0" width="50" height="50" fill="url(#p)"/>' +
      '<g filter="url(#shadow)"><rect x="120" y="0" width="10" height="10" fill="#000"/></g></svg>';
    const { warnings } = await svgPagesToPdf([{ svg }], await testLibrary());

    expect(warnings).toEqual(['그러데이션(첫 색 단색으로) 1곳', 'pattern 채우기(그리지 않음) 1곳', '그림자 등 필터(그리지 않음) 1곳']);
  });

  it('화살표 끝(marker)과 PNG·JPEG 가 아닌 그림은 그리지 않고 warnings 로 알린다', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">' +
      '<line x1="0" y1="10" x2="100" y2="10" stroke="#000000" marker-end="url(#arrow)"/>' +
      '<image x="0" y="20" width="10" height="10" preserveAspectRatio="none" href="data:image/bmp;base64,Qk0="/></svg>';
    const { warnings } = await svgPagesToPdf([{ svg }], await testLibrary());

    expect(warnings).toEqual(['선 끝 모양(화살표 등, 그리지 않음) 1곳', '그림(image/bmp, 그리지 않음) 1곳']);
  });

  it('글꼴이 없는 글자는 빠지고 missingGlyphs 로 센다', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><text x="10" y="50" font-size="20">똠</text></svg>';
    const { stats } = await svgPagesToPdf([{ svg }], await testLibrary());

    expect(stats.missingGlyphs).toBe(1);
  });

  it('보이는 글자는 쓴 글리프만 윤곽(Form)으로 넣고, PDF 글꼴은 보이지 않는 글자 층 하나뿐이다', async () => {
    const doc = openFixture('notice.hwpx');
    const sources = pageSources(doc);
    const { bytes, stats } = await svgPagesToPdf(sources, await testLibrary());
    const pdf = await inspectPdf(bytes);
    const svgChars = new Set([...sources.map((source) => source.svg).join('').matchAll(/>([^<\s])<\/text>/g)].map((match) => match[1]));

    expect(stats.fonts).toHaveLength(1);
    // 글자마다 하나(굵게 합성한 제목 글자는 테두리 넣은 윤곽이 따로 하나 더)
    expect(stats.glyphForms).toBeGreaterThanOrEqual(svgChars.size);
    expect(stats.glyphForms).toBeLessThan(svgChars.size * 2);
    expect(pdf.embeddedFonts).toEqual([]);
    expect(pdf.unembeddedFonts).toEqual([]);
    expect(pdf.type3Fonts).toEqual(['DocbridgeTextLayer']);
    // 시험 글꼴(100KB) 보다 훨씬 작다 — 공문 한 쪽에 쓴 글리프만
    expect(bytes.length).toBeLessThan(readFileSync(REGULAR).length);
  });

  it('CFF 글꼴(맥 Apple SD Gothic Neo 같은)도 같은 윤곽 방식으로 그리고 글자가 뽑힌다 — pdf-lib CFF 부분 집합은 미리보기가 못 읽는다', async () => {
    const doc = openFixture('notice.hwpx');
    const { bytes, stats } = await svgPagesToPdf(pageSources(doc), await cffLibrary());
    const text = compact((await inspectPdf(bytes)).pages.map((page) => page.text).join(''));

    expect(stats.missingGlyphs).toBe(0);
    expect(stats.glyphForms).toBeGreaterThan(0);
    for (const body of bodyTexts(doc)) expect(text).toContain(body);
  });

  it('SVG 글자 테두리(stroke)는 테두리를 넣은 윤곽을 따로 만든다', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">' +
      '<text x="10" y="50" font-family="&apos;Noto Sans KR&apos;" font-size="20" fill="#000000">가</text>' +
      '<text x="60" y="50" font-family="&apos;Noto Sans KR&apos;" font-size="20" fill="#000000" stroke="#ff0000" stroke-width="1">가</text>' +
      '<text x="110" y="50" font-family="&apos;Noto Sans KR&apos;" font-size="20" fill="#000000">가</text></svg>';
    const { stats } = await svgPagesToPdf([{ svg }], await cffLibrary());

    expect(stats.glyphForms).toBe(2);
  });

  it('rhwp 의 굵게 흉내(글자색과 같은 색, 글자 크기 2% 획)는 화면 Canvas 처럼 굵은 글꼴로 그린다', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">' +
      '<text x="10" y="50" font-family="&apos;Noto Sans KR&apos;" font-size="20" fill="#000000" stroke="#000000" stroke-width="0.4">A</text></svg>';
    const library = await fontLibraryFromFiles([REGULAR, BOLD_ASCII], { serif: [], 'sans-serif': ['Noto Sans KR'], fallback: [] });
    const { stats } = await svgPagesToPdf([{ svg }], library);

    expect(stats.fonts).toEqual([`${BOLD_ASCII}#0`]);
    expect(stats.glyphForms).toBe(1);
  });

  it('글자 층 글꼴은 255자마다 하나 더 만든다(한 바이트 코드)', async () => {
    // 시험 글꼴에 든 글자 전부(ASCII + 한글 약 320자)
    const has = await readCoverage(new Uint8Array(readFileSync(CFF)));
    const covered: string[] = [];
    for (let code = 0x21; code <= 0xd7a3; code += 1) if (has(code) && code !== 0x3c && code !== 0x26) covered.push(String.fromCodePoint(code));
    expect(covered.length).toBeGreaterThan(255);
    // 15자씩 줄을 바꿔 쪽 안에 둔다
    const texts = covered.map((char, i) => `<text x="${10 + (i % 15) * 25}" y="${30 + Math.floor(i / 15) * 30}" font-size="20">${char}</text>`);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="${60 + Math.ceil(covered.length / 15) * 30}">${texts.join('')}</svg>`;
    const { bytes } = await svgPagesToPdf([{ svg }], await cffLibrary());
    const pdf = await inspectPdf(bytes);

    expect(pdf.type3Fonts).toHaveLength(Math.ceil(covered.length / 255));
    expect(compact(pdf.pages[0]?.text ?? '').length).toBe(covered.length);
  });

  it('글자 배치(getPageTextLayout)가 있으면 뽑은 글자는 글자 배치 그대로다 — 빈칸 자리만 빈칸, 글자 사이 넓은 틈은 붙는다', async () => {
    // "18:00" 처럼 한글 글꼴 폭 자리에 PDF 글꼴의 좁은 글자가 오면 틈이 생긴다(여기선 가 끝 ~ 나 사이 0.58em). 글자 배치에는 빈칸이 없다
    const svg = lineSvg([
      ['가', 10],
      ['나', 40],
      ['다', 70],
    ]);
    // 글자 배치: "가나 다"(나 와 다 사이에만 빈칸)
    const textLayout = JSON.stringify({ runs: [{ text: '가나 다', x: 10, y: 35, h: 20, charX: [0, 30, 50, 60, 80] }] });
    const { bytes } = await svgPagesToPdf([{ svg, textLayout }], await testLibrary());
    const content = (await pageContents(bytes))[0] ?? '';

    // 글자마다 자리 폭에 맞춘 가로 배율: 가 30px·나 20px·빈칸 10px·다 20px, 글자 크기 20
    expect(content.match(/[\d.]+ Tz/g)).toEqual(['150 Tz', '100 Tz', '50 Tz', '100 Tz']);
    // 글자 자리: x = run.x + charX, 기준선 = run.y + h × LAYER_BASELINE(0.85) = 35 + 17 = 52 (PR #112 리뷰)
    expect(content.match(/1 0 0 -1 [\d.]+ [\d.]+ Tm/g)).toEqual(['1 0 0 -1 10 52 Tm', '1 0 0 -1 40 52 Tm', '1 0 0 -1 60 52 Tm', '1 0 0 -1 70 52 Tm']);
    expect((await inspectPdf(bytes)).pages[0]?.text).toBe('가나 다');
  });

  it('글자 배치가 없으면 SVG 글자를 그 자리에 글자 층으로 둔다(빈칸 글자는 없다)', async () => {
    const svg = lineSvg([
      ['가', 10],
      ['나', 40],
    ]);
    const { bytes } = await svgPagesToPdf([{ svg }], await testLibrary());

    expect(compact((await inspectPdf(bytes)).pages[0]?.text ?? '')).toBe('가나');
  });

  it('fixture 의 쪽 글자 배치로 만든 PDF 에서 뽑은 글자는 본문 빈칸 그대로다(빈칸 하나로 모아 비교)', async () => {
    const doc = openFixture('notice.hwpx');
    const { bytes } = await svgPagesToPdf(pageSources(doc), await testLibrary());
    const text = (await inspectPdf(bytes)).pages.map((page) => page.text).join(' ').replace(/\s+/g, ' ');

    expect(text).toContain('제목 2026년 하반기 주민 안전교육 일정 안내');
    expect(text).toContain('화재 대피 요령, 심폐소생술 실습');
    expect(text).toContain('가나다구청장');
  });
});
