// 사용자가 준 경로를 절대 경로로: ~ 와 ~/ 는 홈 폴더, 상대 경로는 baseDir 기준.
// open_document 는 서버 작업 폴더, save_document 는 원본 폴더를 baseDir 로 쓴다.
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function absolutePath(path: string, baseDir: string, home = homedir()): string {
  if (path === '~' || path.startsWith('~/')) return join(home, path.slice(1));
  return isAbsolute(path) ? resolve(path) : resolve(baseDir, path);
}
