// Node(서버·테스트·스크립트)에서 PDF 글꼴 모으기 — PDF 내보내기 기술 검증(#107, ADR 005).
// 브라우저는 시스템 글꼴 파일을 읽지 못하지만 같은 컴퓨터의 서버는 읽을 수 있다.
// 시스템 글꼴 폴더를 훑어 글꼴 이름·굵기만 읽고(파일 머리만 — 55MB .ttc 도 있다), 바이트는 쓸 때 읽는다.
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bytesReader, extractFace, faceOffsets, readFontFaces, type ByteReader, type FontEntry, type FontLibrary } from './pdf-fonts.ts';

/** 플랫폼별 시스템 글꼴 폴더(사용자 폴더 포함) */
export function systemFontDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  if (platform === 'darwin') {
    // 나눔명조 등 "내려받는 시스템 글꼴"은 AssetsV2 아래에 있다(브라우저는 이름으로 쓴다).
    // FontServices …/Subsets 의 같은 이름 파일은 글리프가 몇 개뿐인 자리표시라 훑지 않는다
    return [
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental',
      '/Library/Fonts',
      join(home, 'Library/Fonts'),
      ...macAssetFontDirs(),
    ];
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

const FONT_FILE = /\.(ttf|otf|ttc)$/i;
const MAC_ASSETS = '/System/Library/AssetsV2';

function macAssetFontDirs(): string[] {
  try {
    return readdirSync(MAC_ASSETS)
      .filter((name) => name.startsWith('com_apple_MobileAsset_Font'))
      .map((name) => join(MAC_ASSETS, name));
  } catch {
    return [];
  }
}

function fontFiles(dir: string, depth = 0): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (FONT_FILE.test(name)) files.push(path);
    else if (depth < 3) {
      try {
        if (statSync(path).isDirectory()) files.push(...fontFiles(path, depth + 1));
      } catch {
        // 읽을 수 없는 폴더는 건너뛴다
      }
    }
  }
  return files;
}

function fileReader(fd: number): ByteReader {
  return (offset, length) => {
    const buffer = new Uint8Array(length);
    readSync(fd, buffer, 0, length, offset);
    return buffer;
  };
}

/** 글꼴 파일들의 머리를 읽어 글꼴 목록을 만든다. 읽지 못하는 파일은 건너뛴다 */
export function fontEntries(paths: string[]): FontEntry[] {
  const entries: FontEntry[] = [];
  for (const path of paths) {
    let fd: number | undefined;
    try {
      fd = openSync(path, 'r');
      for (const face of readFontFaces(fileReader(fd))) {
        // 맥의 "." 로 시작하는 숨은 시스템 글꼴(.Apple SD Gothic NeoI 등)은 한글 이름이 보통 글꼴과 같아 섞이지 않게 뺀다
        if (face.postscriptName.startsWith('.')) continue;
        entries.push({ ...face, id: `${path}#${face.index}` });
      }
    } catch {
      // 깨졌거나 모르는 형식(.dfont 등)
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return entries;
}

/** 글꼴 파일들 → FontLibrary. 바이트는 처음 쓸 때 읽어 둔다(모음은 그 글꼴만 떼어 낸다) */
export function fontLibraryFromFiles(paths: string[], generic: FontLibrary['generic'] = GENERIC_FAMILIES): FontLibrary {
  const faces = fontEntries(paths);
  const loaded = new Map<string, Promise<Uint8Array>>();
  return {
    faces,
    generic,
    load(id) {
      let bytes = loaded.get(id);
      if (bytes === undefined) {
        const hash = id.lastIndexOf('#');
        const path = id.slice(0, hash);
        const index = Number(id.slice(hash + 1));
        const file = new Uint8Array(readFileSync(path));
        const read = bytesReader(file);
        bytes = Promise.resolve(faceOffsets(read).length > 1 || index > 0 ? extractFace(read, index) : file);
        loaded.set(id, bytes);
      }
      return bytes;
    },
  };
}

/** 이 컴퓨터의 시스템 글꼴 전부 */
export function systemFontLibrary(): FontLibrary {
  // 폴더가 겹치므로(/System/Library/Fonts 아래 Supplemental) 같은 파일은 한 번만
  return fontLibraryFromFiles([...new Set(systemFontDirs().flatMap((dir) => fontFiles(dir)))]);
}
