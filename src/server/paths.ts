// 사용자가 준 경로를 절대 경로로: ~ 와 ~/ (윈도우는 ~\ 도) 는 홈 폴더, 상대 경로는 baseDir 기준.
// open_document 는 서버 작업 폴더, save_document 는 원본 폴더를 baseDir 로 쓴다.
// 경로 규칙(rules)은 지금 플랫폼의 node:path 가 기본이고, 테스트는 path.win32·path.posix 를 넣는다(SPEC-004 AC-5).
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path, { basename, dirname, join, type PlatformPath } from 'node:path';

export type PathRules = PlatformPath;

/** 윈도우는 \ 와 / 둘 다 구분자다 */
const separatorsOf = (rules: PathRules) => (rules.sep === '\\' ? ['/', '\\'] : ['/']);

/** ~ 이나 ~/ (윈도우는 ~\ 도)로 시작하는 홈 폴더 경로인지 */
const isHomePath = (raw: string, rules: PathRules) => raw === '~' || separatorsOf(rules).some((sep) => raw.startsWith(`~${sep}`));

/** 구분자로 끝나는지(폴더를 준 것) */
export const endsWithSeparator = (raw: string, rules: PathRules) => separatorsOf(rules).some((sep) => raw.endsWith(sep));

/**
 * 절대 경로나 ~ 로 시작하는 경로인지. 윈도우는 C:\…·C:/…·\\server\share·\… (지금 드라이브 맨 위)가 절대 경로이고,
 * 드라이브만 있는 C:이름 은 그 드라이브의 작업 폴더 기준이라 상대 경로다
 */
export const isAbsoluteInput = (raw: string, rules: PathRules = path) => isHomePath(raw, rules) || rules.isAbsolute(raw);

export function absolutePath(raw: string, baseDir: string, home = homedir(), rules: PathRules = path): string {
  if (isHomePath(raw, rules)) return rules.join(home, raw.slice(1));
  // resolve 가 절대 경로는 그대로 두고, 구분자(윈도우의 / 섞임)·..·. 를 정리한다
  return rules.resolve(baseDir, raw);
}

/**
 * 같은 파일을 가리는 열쇠: 링크를 따라간 실제 경로(macOS /tmp ↔ /private/tmp 등, SPEC-007 같은 파일 판정·PR #74 리뷰).
 * 있는 파일은 운영체제의 실제 이름으로 돌아온다(대소문자를 가리지 않는 macOS·윈도우에서 대소문자만 다른 경로도 같은 열쇠).
 * 아직 없는 파일(저장할 자리)이면 폴더만 따라가고, 폴더도 없으면 경로 그대로
 */
export async function realFilePath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    const folder = await realpath(dirname(filePath)).catch(() => dirname(filePath));
    return join(folder, basename(filePath));
  }
}
