// rhwp 쪽 SVG(renderPageSvg) 읽기 — PDF 내보내기 기술 검증(#107, ADR 005).
// DOM 없이(Node 서버·테스트·브라우저 공용) rhwp 가 만드는 SVG 를 요소 나무로 읽는다.
// rhwp SVG 는 기계가 만든 정해진 모양이라(따옴표 속성, 주석·CDATA 없음) 작은 읽개로 충분하다.
// 그래도 주석·<?xml?>·<!DOCTYPE> 는 건너뛴다(다른 rhwp 판이 붙일 수 있게).

export interface SvgElement {
  tag: string;
  attrs: Map<string, string>;
  children: SvgNode[];
}

export type SvgNode = SvgElement | { text: string };

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML 글자 참조(&amp; &#44032; &#xAC00;)를 푼다. 모르는 이름은 그대로 둔다 */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole: string, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return NAMED_ENTITIES[body] ?? whole;
  });
}

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1];
    const value = match[2] ?? match[3] ?? '';
    if (name !== undefined) attrs.set(name, decodeEntities(value));
  }
  return attrs;
}

/** SVG 문자열 → 뿌리 요소. 닫는 태그가 맞지 않으면 던진다 */
export function parseSvg(source: string): SvgElement {
  const root: SvgElement = { tag: '#root', attrs: new Map(), children: [] };
  const stack: SvgElement[] = [root];
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf('<', index);
    const current = stack[stack.length - 1] ?? root;
    if (open < 0) {
      pushText(current, source.slice(index));
      break;
    }
    if (open > index) pushText(current, source.slice(index, open));
    if (source.startsWith('<!--', open)) {
      index = endOf(source, '-->', open);
      continue;
    }
    if (source.startsWith('<?', open) || source.startsWith('<!', open)) {
      index = endOf(source, '>', open);
      continue;
    }
    const close = endOf(source, '>', open);
    const body = source.slice(open + 1, close - 1);
    index = close;
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      const top = stack.pop();
      if (top === undefined || top.tag !== name) throw new Error(`SVG 닫는 태그가 맞지 않습니다: </${name}>`);
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameEnd = inner.search(/[\s]/);
    const tag = nameEnd < 0 ? inner : inner.slice(0, nameEnd);
    const element: SvgElement = { tag, attrs: parseAttributes(nameEnd < 0 ? '' : inner.slice(nameEnd)), children: [] };
    current.children.push(element);
    if (!selfClosing) stack.push(element);
  }
  if (stack.length !== 1) throw new Error('SVG 가 닫히지 않았습니다');
  const svg = root.children.find(isElement);
  if (svg === undefined || svg.tag !== 'svg') throw new Error('<svg> 요소가 없습니다');
  return svg;
}

function endOf(source: string, marker: string, from: number): number {
  const at = source.indexOf(marker, from);
  if (at < 0) throw new Error('SVG 태그가 끝나지 않았습니다');
  return at + marker.length;
}

function pushText(parent: SvgElement, raw: string): void {
  if (raw.length === 0) return;
  parent.children.push({ text: decodeEntities(raw) });
}

export function isElement(node: SvgNode): node is SvgElement {
  return 'tag' in node;
}

/** 요소 안 글자(자식 글자 이어 붙임) */
export function textContent(element: SvgElement): string {
  return element.children.map((child) => (isElement(child) ? textContent(child) : child.text)).join('');
}

/** 숫자 속성. 없거나 숫자가 아니면 fallback */
export function numberAttr(element: SvgElement, name: string, fallback = 0): number {
  const raw = element.attrs.get(name);
  if (raw === undefined) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** 2D 변환 행렬 [a b c d e f] (SVG/PDF 같은 차례) */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  // m 다음에 n (점 p → m·(n·p))
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** transform 속성(translate·scale·rotate·matrix·skewX·skewY) → 행렬 */
export function parseTransform(value: string | undefined): Matrix {
  if (value === undefined) return IDENTITY;
  let result: Matrix = IDENTITY;
  for (const match of value.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const args = (match[2] ?? '').split(/[\s,]+/).filter((part) => part.length > 0).map(Number);
    const [a = 0, b, c, d, e, f] = args;
    let next: Matrix = IDENTITY;
    switch (match[1]) {
      case 'matrix':
        next = [a, b ?? 0, c ?? 0, d ?? 0, e ?? 0, f ?? 0];
        break;
      case 'translate':
        next = [1, 0, 0, 1, a, b ?? 0];
        break;
      case 'scale':
        next = [a, 0, 0, b ?? a, 0, 0];
        break;
      case 'rotate': {
        const rad = (a * Math.PI) / 180;
        const rotation: Matrix = [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];
        next = b === undefined ? rotation : multiply(multiply([1, 0, 0, 1, b, c ?? 0], rotation), [1, 0, 0, 1, -b, -(c ?? 0)]);
        break;
      }
      case 'skewX':
        next = [1, 0, Math.tan((a * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        next = [1, Math.tan((a * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    result = multiply(result, next);
  }
  return result;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const NAMED_COLORS: Record<string, Rgb> = {
  black: { r: 0, g: 0, b: 0 },
  white: { r: 1, g: 1, b: 1 },
  red: { r: 1, g: 0, b: 0 },
  blue: { r: 0, g: 0, b: 1 },
  gray: { r: 128 / 255, g: 128 / 255, b: 128 / 255 },
  grey: { r: 128 / 255, g: 128 / 255, b: 128 / 255 },
};

/** fill·stroke 색. none·transparent·url(...)(그러데이션·무늬)은 undefined */
export function parseColor(value: string | undefined): Rgb | undefined {
  if (value === undefined) return undefined;
  const color = value.trim().toLowerCase();
  if (color === 'none' || color === 'transparent' || color.startsWith('url(')) return undefined;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(color)?.[1];
  if (hex !== undefined) {
    const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
    return {
      r: Number.parseInt(full.slice(0, 2), 16) / 255,
      g: Number.parseInt(full.slice(2, 4), 16) / 255,
      b: Number.parseInt(full.slice(4, 6), 16) / 255,
    };
  }
  const rgb = /^rgba?\(([^)]*)\)$/.exec(color)?.[1];
  if (rgb !== undefined) {
    const [r = 0, g = 0, b = 0] = rgb.split(',').map((part) => Number.parseFloat(part) / 255);
    return { r, g, b };
  }
  return NAMED_COLORS[color];
}

/** font-family 속성 → 글꼴 이름 차례(따옴표 벗김) */
export function parseFontFamilies(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter((name) => name.length > 0);
}

/** font-weight → 숫자(normal 400, bold 700) */
export function parseFontWeight(value: string | undefined): number {
  if (value === undefined || value === 'normal') return 400;
  if (value === 'bold' || value === 'bolder') return 700;
  if (value === 'lighter') return 300;
  const weight = Number.parseInt(value, 10);
  return Number.isFinite(weight) ? weight : 400;
}
