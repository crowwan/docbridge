// Node(서버·테스트·스크립트)에서 PDF 글꼴 모으기 — PDF 내보내기(SPEC-008, ADR 005).
// 브라우저는 시스템 글꼴 파일을 읽지 못하지만 같은 컴퓨터의 서버는 읽을 수 있다.
// 시스템 글꼴 폴더를 훑어 글꼴 이름·굵기만 읽고(파일 머리만 — 55MB .ttc 도 있다), 바이트는 쓸 때 읽는다.
// 모두 비동기(fs.promises): 서버는 MCP(stdio)·뷰어(HTTP·WebSocket)와 같은 프로세스라, 글꼴 1,000여 개를 읽는 동안 이벤트 루프를 막지 않는다(PR #112 리뷰).
import { open, readdir, readFile, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bytesReader, extractFace, faceOffsets, readFontFaces, type ByteReader, type FontEntry, type FontLibrary } from './pdf-fonts.ts';

/** 플랫폼별 시스템 글꼴 폴더(사용자 폴더 포함). 맥 내려받는 글꼴 폴더(AssetsV2)는 systemFontLibrary 가 훑을 때 더한다 */
export function systemFontDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  if (platform === 'darwin') {
    return ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', join(home, 'Library/Fonts')];
  }
  if (platform === 'win32') {
    const windows = env['WINDIR'] ?? 'C:\\Windows';
    const local = env['LOCALAPPDATA'];
    return [join(windows, 'Fonts'), ...(local === undefined ? [] : [join(local, 'Microsoft', 'Windows', 'Fonts')])];
  }
  return ['/usr/share/fonts', '/usr/local/share/fonts', join(home, '.local/share/fonts'), join(home, '.fonts')];
}

/**
 * 브라우저 기본 글꼴 흉내(차례에 있는 이름이 하나도 없을 때). rhwp 대체 차례 끝이 serif·sans-serif 라
 * 브라우저가 그 컴퓨터의 한글 기본 글꼴을 쓰는 것과 맞춘다
 */
export const GENERIC_FAMILIES: FontLibrary['generic'] = {
  serif: ['AppleMyungjo', 'Batang', '바탕', 'Nanum Myeongjo', 'Noto Serif CJK KR', 'Noto Serif KR'],
  'sans-serif': ['Apple SD Gothic Neo', 'Malgun Gothic', '맑은 고딕', 'NanumGothic', 'Noto Sans CJK KR', 'Noto Sans KR'],
  // 공문에 자주 나오는 기호(∙ ‧ ․ ⇨ ①)가 한글 글꼴에 없을 때 — 맥·윈도우·리눅스 기호 글꼴
  fallback: ['Apple Symbols', 'Hiragino Sans', 'Arial Unicode MS', 'Segoe UI Symbol', 'Segoe UI', 'MS Gothic', 'DejaVu Sans', 'Noto Sans Symbols2', 'Noto Sans Symbols'],
};

/**
 * 읽어 둔 글꼴 바이트(떼어 낸 글꼴 하나씩)를 서버 수명 동안 이만큼까지만 둔다. 넘으면 가장 오래 안 쓴 것부터 버린다(LRU).
 * 96MB: 실제 공고문(8쪽)이 쓴 글꼴 7개가 74.3MB(ADR 005) — 한 문서를 다시 내보낼 때는 다시 읽지 않고,
 * 다른 문서로 넘어가도 Claude Desktop 서버 프로세스가 100MB 남짓 넘게 붙잡지 않는다. 버린 글꼴은 다음에 디스크에서 다시 읽는다(SSD 수십 ms)
 */
export const FONT_CACHE_BYTES = 96 * 1024 * 1024;

/** 맥 "내려받는 시스템 글꼴"(나눔명조 등 — 브라우저는 이름으로 쓴다). Apple 이 공개하지 않은 경로라 macOS 판을 올리면 다시 본다(ADR 005) */
const MAC_ASSETS = '/System/Library/AssetsV2';
const FONT_FILE = /\.(ttf|otf|ttc)$/i;
/** 머리 읽기를 동시에 이만큼(파일 1,000여 개 — 파일 핸들을 너무 많이 열지 않게) */
const READ_CONCURRENCY = 16;

async function macAssetFontDirs(): Promise<string[]> {
  try {
    // FontServices …/Subsets 의 같은 이름 파일은 글리프가 몇 개뿐인 자리표시라 훑지 않는다
    return (await readdir(MAC_ASSETS)).filter((name) => name.startsWith('com_apple_MobileAsset_Font')).map((name) => join(MAC_ASSETS, name));
  } catch {
    return [];
  }
}

async function fontFiles(dir: string, depth = 0): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (FONT_FILE.test(name)) files.push(path);
    else if (depth < 3 && (await stat(path).catch(() => undefined))?.isDirectory() === true) files.push(...(await fontFiles(path, depth + 1)));
  }
  return files;
}

/** 파일 하나의 글꼴들(읽지 못하는 파일은 빈 목록) */
async function fileEntries(path: string): Promise<FontEntry[]> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    const file = handle;
    const read: ByteReader = async (offset, length) => {
      const buffer = new Uint8Array(length);
      await file.read(buffer, 0, length, offset);
      return buffer;
    };
    // 맥의 "." 로 시작하는 숨은 시스템 글꼴(.Apple SD Gothic NeoI 등)은 한글 이름이 보통 글꼴과 같아 섞이지 않게 뺀다
    return (await readFontFaces(read)).filter((face) => !face.postscriptName.startsWith('.')).map((face) => ({ ...face, id: `${path}#${face.index}` }));
  } catch {
    // 깨졌거나 모르는 형식(.dfont 등)
    return [];
  } finally {
    await handle?.close();
  }
}

/** 글꼴 파일들의 머리를 읽어 글꼴 목록을 만든다(파일 차례 그대로). 읽지 못하는 파일은 건너뛴다 */
export async function fontEntries(paths: string[]): Promise<FontEntry[]> {
  const results: FontEntry[][] = new Array(paths.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const index = next;
      next += 1;
      results[index] = await fileEntries(paths[index] ?? '');
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, worker));
  return results.flat();
}

/** 글꼴 바이트 캐시: 바이트 합이 limit 를 넘으면 가장 오래 안 쓴 것부터 버린다 */
export class FontBytesCache {
  private readonly entries = new Map<string, Uint8Array>();
  private total = 0;
  private readonly limit: number;

  constructor(limit = FONT_CACHE_BYTES) {
    this.limit = limit;
  }

  get(id: string): Uint8Array | undefined {
    const bytes = this.entries.get(id);
    if (bytes !== undefined) {
      // 맨 뒤(가장 최근)로
      this.entries.delete(id);
      this.entries.set(id, bytes);
    }
    return bytes;
  }

  set(id: string, bytes: Uint8Array): void {
    this.delete(id);
    // 한도보다 큰 글꼴 하나는 두지 않는다(쓸 때마다 읽는다)
    if (bytes.length > this.limit) return;
    for (const [oldest] of this.entries) {
      if (this.total + bytes.length <= this.limit) break;
      this.delete(oldest);
    }
    this.entries.set(id, bytes);
    this.total += bytes.length;
  }

  private delete(id: string): void {
    const bytes = this.entries.get(id);
    if (bytes === undefined) return;
    this.entries.delete(id);
    this.total -= bytes.length;
  }

  /** 지금 들고 있는 바이트 합 */
  get bytes(): number {
    return this.total;
  }

  get ids(): string[] {
    return [...this.entries.keys()];
  }
}

/** 글꼴 하나를 따로 선 바이트로 읽는다(모음은 그 글꼴만 떼어 낸다 — 55MB 모음 전체를 붙잡지 않는다) */
async function loadFace(id: string): Promise<Uint8Array> {
  const hash = id.lastIndexOf('#');
  const index = Number(id.slice(hash + 1));
  const file = new Uint8Array(await readFile(id.slice(0, hash)));
  const read = bytesReader(file);
  return (await faceOffsets(read)).length > 1 || index > 0 ? extractFace(read, index) : file;
}

/** 글꼴 파일들 → FontLibrary. 바이트는 처음 쓸 때 읽어 cache 에 둔다(같은 글꼴을 동시에 읽으면 한 번만) */
export async function fontLibraryFromFiles(
  paths: string[],
  generic: FontLibrary['generic'] = GENERIC_FAMILIES,
  cache = new FontBytesCache(),
): Promise<FontLibrary> {
  const faces = await fontEntries(paths);
  const reading = new Map<string, Promise<Uint8Array>>();
  return {
    faces,
    generic,
    load(id) {
      const cached = cache.get(id);
      if (cached !== undefined) return Promise.resolve(cached);
      let pending = reading.get(id);
      if (pending === undefined) {
        pending = loadFace(id).then(
          (bytes) => {
            reading.delete(id);
            cache.set(id, bytes);
            return bytes;
          },
          (error: unknown) => {
            reading.delete(id);
            throw error;
          },
        );
        reading.set(id, pending);
      }
      return pending;
    },
  };
}

/** 이 컴퓨터의 시스템 글꼴 전부 */
export async function systemFontLibrary(cache?: FontBytesCache): Promise<FontLibrary> {
  const dirs = [...systemFontDirs(), ...(process.platform === 'darwin' ? await macAssetFontDirs() : [])];
  // 폴더가 겹치므로(/System/Library/Fonts 아래 Supplemental) 같은 파일은 한 번만
  const files = [...new Set((await Promise.all(dirs.map((dir) => fontFiles(dir)))).flat())];
  return fontLibraryFromFiles(files, GENERIC_FAMILIES, cache);
}
