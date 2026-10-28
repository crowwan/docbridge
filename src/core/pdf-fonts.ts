// PDF 에 넣을 글꼴 고르기 — PDF 내보내기 기술 검증(#107, ADR 005).
// 브라우저는 시스템 글꼴 파일을 읽을 수 없어서, 글꼴 바이트는 서버(Node)가 시스템 글꼴 폴더에서 읽는다.
// 여기는 바이트만 다루는 순수 함수(파일 읽기는 부르는 쪽): TrueType/OpenType(.ttf/.otf)·모음(.ttc) 머리,
// 이름(name: 모든 언어의 글꼴 이름)·굵기(OS/2)·넣어도 되는지(OS/2 fsType)·글자 있는지(cmap) 읽기,
// 모음에서 글꼴 하나 떼어 내기, 그리고 SVG font-family 차례 + 굵기 + 글자 → 글꼴(브라우저 CSS 글꼴 고르기 흉내).

/** 파일의 [offset, offset+length) 를 돌려준다. 파일을 다 읽지 않고 머리·표만 읽게(55MB .ttc 도 있다) */
export type ByteReader = (offset: number, length: number) => Uint8Array;

export function bytesReader(bytes: Uint8Array): ByteReader {
  return (offset, length) => bytes.subarray(offset, offset + length);
}

interface TableRecord {
  tag: string;
  offset: number;
  length: number;
}

export interface FontFaceInfo {
  /** 모음(.ttc) 안 순서. 한 글꼴 파일이면 0 */
  index: number;
  /** 글꼴 이름들(name 1·16, 모든 언어 — "Apple SD Gothic Neo", "애플 SD 산돌고딕 Neo" …) */
  families: string[];
  /** PostScript 이름(name 6) */
  postscriptName: string;
  /** OS/2 usWeightClass(없으면 400) */
  weight: number;
  italic: boolean;
  /** OS/2 fsType 이 "넣지 마시오"(Restricted License, 2 만 켜짐)가 아니다 */
  embeddable: boolean;
  fsType: number;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function tag(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
}

/** 글꼴 하나(sfnt 머리 위치)의 표 목록 */
function tableRecords(read: ByteReader, faceOffset: number): TableRecord[] {
  const numTables = view(read(faceOffset + 4, 2)).getUint16(0);
  const directory = read(faceOffset + 12, numTables * 16);
  const data = view(directory);
  const records: TableRecord[] = [];
  for (let i = 0; i < numTables; i += 1) {
    records.push({ tag: tag(directory, i * 16), offset: data.getUint32(i * 16 + 8), length: data.getUint32(i * 16 + 12) });
  }
  return records;
}

/** 파일 안 글꼴들의 sfnt 머리 위치(.ttc 면 여럿) */
export function faceOffsets(read: ByteReader): number[] {
  const header = read(0, 12);
  if (tag(header, 0) !== 'ttcf') return [0];
  const count = view(header).getUint32(8);
  const offsets = view(read(12, count * 4));
  return Array.from({ length: count }, (_, i) => offsets.getUint32(i * 4));
}

function utf16be(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) text += String.fromCharCode(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
  return text;
}

function latin1(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

/** name 표 → nameID 별 이름들(윈도우 UTF-16 모든 언어 + 맥 로마자) */
function readNames(read: ByteReader, table: TableRecord): Map<number, string[]> {
  const bytes = read(table.offset, table.length);
  const data = view(bytes);
  const count = data.getUint16(2);
  const stringOffset = data.getUint16(4);
  const names = new Map<number, string[]>();
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 12;
    const platform = data.getUint16(at);
    const encoding = data.getUint16(at + 2);
    const nameId = data.getUint16(at + 6);
    const length = data.getUint16(at + 8);
    const offset = data.getUint16(at + 10);
    const raw = bytes.subarray(stringOffset + offset, stringOffset + offset + length);
    let value: string | undefined;
    if (platform === 3 || platform === 0) value = utf16be(raw);
    else if (platform === 1 && encoding === 0) value = latin1(raw);
    if (value === undefined || value.length === 0) continue;
    const list = names.get(nameId) ?? [];
    if (!list.includes(value)) list.push(value);
    names.set(nameId, list);
  }
  return names;
}

/** 파일 안 글꼴마다 이름·굵기·넣어도 되는지 */
export function readFontFaces(read: ByteReader): FontFaceInfo[] {
  return faceOffsets(read).map((faceOffset, index) => {
    const tables = tableRecords(read, faceOffset);
    const name = tables.find((table) => table.tag === 'name');
    const os2 = tables.find((table) => table.tag === 'OS/2');
    const head = tables.find((table) => table.tag === 'head');
    const names = name === undefined ? new Map<number, string[]>() : readNames(read, name);
    const families = [...new Set([...(names.get(16) ?? []), ...(names.get(1) ?? [])])];
    let weight = 400;
    let fsType = 0;
    let italic = false;
    if (os2 !== undefined) {
      const data = view(read(os2.offset, Math.min(os2.length, 64)));
      weight = data.getUint16(4);
      fsType = data.getUint16(8);
      italic = (data.getUint16(62) & 1) === 1;
    } else if (head !== undefined) {
      const macStyle = view(read(head.offset + 44, 2)).getUint16(0);
      weight = (macStyle & 1) === 1 ? 700 : 400;
      italic = (macStyle & 2) === 2;
    }
    return {
      index,
      families,
      postscriptName: names.get(6)?.[0] ?? '',
      weight,
      italic,
      // 비트 1(값 2)만 켜지고 2·3(4·8, 미리 보기·편집 허용)이 꺼지면 넣으면 안 된다(OpenType OS/2 fsType)
      embeddable: (fsType & 0x000e) !== 0x0002,
      fsType,
    };
  });
}

/** 모음(.ttc) 안 글꼴 하나를 따로 선 .ttf 바이트로. pdf-lib(fontkit)는 모음을 바로 넣지 못한다 */
export function extractFace(read: ByteReader, index: number): Uint8Array {
  const faceOffset = faceOffsets(read)[index];
  if (faceOffset === undefined) throw new Error(`글꼴 모음에 ${index}번 글꼴이 없습니다`);
  const tables = tableRecords(read, faceOffset);
  const headerLength = 12 + tables.length * 16;
  const padded = (length: number): number => (length + 3) & ~3;
  const total = tables.reduce((sum, table) => sum + padded(table.length), headerLength);
  const out = new Uint8Array(total);
  const data = view(out);
  out.set(read(faceOffset, 4), 0);
  data.setUint16(4, tables.length);
  let power = 1;
  let log = 0;
  while (power * 2 <= tables.length) {
    power *= 2;
    log += 1;
  }
  data.setUint16(6, power * 16);
  data.setUint16(8, log);
  data.setUint16(10, tables.length * 16 - power * 16);
  const sourceDirectory = read(faceOffset + 12, tables.length * 16);
  let offset = headerLength;
  tables.forEach((table, i) => {
    out.set(sourceDirectory.subarray(i * 16, i * 16 + 8), 12 + i * 16);
    data.setUint32(12 + i * 16 + 8, offset);
    data.setUint32(12 + i * 16 + 12, table.length);
    out.set(read(table.offset, table.length), offset);
    offset += padded(table.length);
  });
  return out;
}

/** 글자(코드 포인트) → 글꼴에 글리프가 있는지. cmap 형식 4(BMP)·12(전체)를 읽는다 */
export type Coverage = (codePoint: number) => boolean;

export function readCoverage(fontBytes: Uint8Array): Coverage {
  const read = bytesReader(fontBytes);
  const cmap = tableRecords(read, 0).find((table) => table.tag === 'cmap');
  if (cmap === undefined) return () => false;
  const bytes = read(cmap.offset, cmap.length);
  const data = view(bytes);
  const count = data.getUint16(2);
  let format4: number | undefined;
  let format12: number | undefined;
  for (let i = 0; i < count; i += 1) {
    const platform = data.getUint16(4 + i * 8);
    const encoding = data.getUint16(4 + i * 8 + 2);
    const offset = data.getUint32(4 + i * 8 + 4);
    const format = data.getUint16(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format === 12) format12 ??= offset;
    if (format === 4) format4 ??= offset;
  }
  if (format12 !== undefined) {
    const at = format12;
    const groups = data.getUint32(at + 12);
    return (codePoint) => {
      let low = 0;
      let high = groups - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const start = data.getUint32(at + 16 + middle * 12);
        const end = data.getUint32(at + 16 + middle * 12 + 4);
        if (codePoint < start) high = middle - 1;
        else if (codePoint > end) low = middle + 1;
        else return data.getUint32(at + 16 + middle * 12 + 8) + (codePoint - start) !== 0;
      }
      return false;
    };
  }
  if (format4 !== undefined) {
    const at = format4;
    const segments = data.getUint16(at + 6) / 2;
    const endCodes = at + 14;
    const startCodes = endCodes + segments * 2 + 2;
    const deltas = startCodes + segments * 2;
    const rangeOffsets = deltas + segments * 2;
    return (codePoint) => {
      if (codePoint > 0xffff) return false;
      for (let i = 0; i < segments; i += 1) {
        if (codePoint > data.getUint16(endCodes + i * 2)) continue;
        const start = data.getUint16(startCodes + i * 2);
        if (codePoint < start) return false;
        const delta = data.getInt16(deltas + i * 2);
        const rangeOffset = data.getUint16(rangeOffsets + i * 2);
        if (rangeOffset === 0) return ((codePoint + delta) & 0xffff) !== 0;
        const glyphAt = rangeOffsets + i * 2 + rangeOffset + (codePoint - start) * 2;
        const glyph = data.getUint16(glyphAt);
        return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
      }
      return false;
    };
  }
  return () => false;
}

/** 쓸 수 있는 글꼴 하나(서버가 시스템 글꼴 폴더에서 모은 것, 또는 테스트 글꼴) */
export interface FontEntry extends FontFaceInfo {
  /** 파일 경로 + 모음 안 순서 같은, 바이트를 다시 얻을 열쇠 */
  id: string;
}

export interface FontLibrary {
  faces: FontEntry[];
  /** 따로 선 .ttf/.otf 바이트(모음이면 떼어 낸 것) */
  load(id: string): Promise<Uint8Array>;
  /**
   * 차례의 이름이 하나도 없을 때 쓸 이름들(브라우저 기본 글꼴 흉내: serif·sans-serif 마다),
   * fallback = 그래도 그 글자가 없을 때 마지막으로 찾아볼 기호·다국어 글꼴(브라우저의 글자별 대체 글꼴 흉내)
   */
  generic: Record<'serif' | 'sans-serif' | 'fallback', string[]>;
}

export interface FontChoice {
  id: string;
  /** 굵게를 바랐는데 굵은 글꼴이 없어 획을 덧그린다(브라우저 합성 굵게처럼) */
  syntheticBold: boolean;
  /** 기울임을 바랐는데 기울임 글꼴이 없어 기울인다 */
  syntheticItalic: boolean;
}

/** CSS 글꼴 고르기의 굵기 차례(CSS Fonts 4 "font-weight matching") */
function weightOrder(faces: FontEntry[], wanted: number): FontEntry[] {
  const score = (weight: number): number => {
    if (weight === wanted) return 0;
    if (wanted >= 400 && wanted <= 500) {
      if (weight > wanted && weight <= 500) return weight - wanted;
      if (weight < wanted) return 1000 + (wanted - weight);
      return 2000 + (weight - wanted);
    }
    if (wanted < 400) return weight < wanted ? wanted - weight : 1000 + (weight - wanted);
    return weight > wanted ? weight - wanted : 1000 + (wanted - weight);
  };
  return [...faces].sort((a, b) => score(a.weight) - score(b.weight));
}

const GENERIC_NAMES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);

/**
 * SVG font-family 차례·굵기·기울임·글자 → 넣을 글꼴. 브라우저처럼 차례대로 "있고, 그 글자가 있는" 첫 글꼴.
 * 차례에 없으면 차례 끝 일반 이름(serif·sans-serif)의 기본 글꼴, 그래도 없으면 아무 글꼴이나 그 글자가 있는 것.
 * 넣으면 안 되는(fsType Restricted) 글꼴은 건너뛴다. 아무 데도 없으면 undefined(그 글자는 PDF 에 빠진다)
 */
export class FontResolver {
  private readonly coverages = new Map<string, Promise<Coverage>>();
  private readonly byFamily = new Map<string, FontEntry[]>();
  private readonly choices = new Map<string, Promise<FontChoice | undefined>>();

  private readonly library: FontLibrary;

  constructor(library: FontLibrary) {
    this.library = library;
    for (const face of library.faces) {
      if (!face.embeddable) continue;
      for (const family of face.families) {
        const key = family.toLowerCase();
        const list = this.byFamily.get(key) ?? [];
        list.push(face);
        this.byFamily.set(key, list);
      }
    }
  }

  private coverage(id: string): Promise<Coverage> {
    let coverage = this.coverages.get(id);
    if (coverage === undefined) {
      coverage = this.library.load(id).then(readCoverage);
      this.coverages.set(id, coverage);
    }
    return coverage;
  }

  private async pick(faces: FontEntry[], weight: number, italic: boolean, codePoint: number): Promise<FontChoice | undefined> {
    const styled = faces.filter((face) => face.italic === italic);
    const ordered = [...weightOrder(styled, weight), ...weightOrder(faces.filter((face) => face.italic !== italic), weight)];
    for (const face of ordered) {
      if (!(await this.coverage(face.id))(codePoint)) continue;
      return { id: face.id, syntheticBold: weight >= 600 && face.weight < 600, syntheticItalic: italic && !face.italic };
    }
    return undefined;
  }

  resolve(families: string[], weight: number, italic: boolean, char: string): Promise<FontChoice | undefined> {
    const key = `${families.join(',')}|${weight}|${italic}|${char}`;
    let choice = this.choices.get(key);
    if (choice === undefined) {
      choice = this.resolveUncached(families, weight, italic, char);
      this.choices.set(key, choice);
    }
    return choice;
  }

  private async resolveUncached(families: string[], weight: number, italic: boolean, char: string): Promise<FontChoice | undefined> {
    const codePoint = char.codePointAt(0) ?? 0;
    const generic = families.findLast((name) => GENERIC_NAMES.has(name)) === 'serif' ? 'serif' : 'sans-serif';
    const other = generic === 'serif' ? 'sans-serif' : 'serif';
    // 마지막은 다른 일반 이름의 기본 글꼴, 그다음 기호·다국어 글꼴(브라우저의 글자별 대체 글꼴처럼).
    // 시스템 글꼴 전부를 열어 보지는 않는다(맥은 1,000개 넘게 — 글자마다 다 열면 느리다)
    const names = [
      ...families.filter((name) => !GENERIC_NAMES.has(name)),
      ...this.library.generic[generic],
      ...this.library.generic[other],
      ...this.library.generic.fallback,
    ];
    for (const name of names) {
      const faces = this.byFamily.get(name.toLowerCase());
      if (faces === undefined) continue;
      const choice = await this.pick(faces, weight, italic, codePoint);
      if (choice !== undefined) return choice;
    }
    return undefined;
  }
}
