// 사용자가 준 경로를 절대 경로로: ~ 와 ~/ 는 홈 폴더, 상대 경로는 baseDir 기준.
// open_document 는 서버 작업 폴더, save_document 는 원본 폴더를 baseDir 로 쓴다.
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export function absolutePath(path: string, baseDir: string, home = homedir()): string {
  if (path === '~' || path.startsWith('~/')) return join(home, path.slice(1));
  return isAbsolute(path) ? resolve(path) : resolve(baseDir, path);
}

/**
 * 같은 파일을 가리는 열쇠: 링크를 따라간 실제 경로(macOS /tmp ↔ /private/tmp 등, SPEC-007 같은 파일 판정·PR #74 리뷰).
 * 아직 없는 파일(저장할 자리)이면 폴더만 따라가고, 폴더도 없으면 경로 그대로
 */
export async function realFilePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const folder = await realpath(dirname(path)).catch(() => dirname(path));
    return join(folder, basename(path));
  }
}
