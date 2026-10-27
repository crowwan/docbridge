// save_document 의 저장 경로 정하기와 파일 쓰기 (SPEC-002 "저장").
// 저장은 항상 HWPX. 경로가 없으면 원본 옆 <이름>-수정.hwpx(겹치면 -수정-2 …),
// 원본은 overwrite: true 이고 원본이 .hwpx 일 때만, 이미 있는 다른 파일은 overwrite: true 일 때만 덮어쓴다.
// 경로를 정할 때 한 번 검사하고(내보내기 전에 빨리 실패), 쓸 때 덮어쓰지 않는 저장은 배타적으로 만들어 그사이 생긴 파일도 덮지 않는다.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, link, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { errorMessage } from '../shared/errors.ts';
import { absolutePath } from './paths.ts';

const SAVE_EXTENSION = '.hwpx';

export interface SavePathRequest {
  /** 지금 문서를 연 파일(원본). 기본 이름과 상대 경로의 기준이다 */
  sourcePath: string;
  /** save_document 의 path. 없으면 기본 이름 */
  path?: string;
  overwrite: boolean;
}

const statOf = (path: string) => stat(path).catch(() => undefined);

const existingFileMessage = (path: string) => `이미 있는 파일입니다: ${path}. 덮어쓰려면 overwrite: true 를 주세요.`;
const folderMessage = (path: string) => `폴더입니다: ${path}. 파일 경로를 주세요.`;


/** 원본 옆 기본 이름의 n 번째(1 이면 <이름>-수정.hwpx, 아니면 <이름>-수정-n.hwpx) */
const numberedPath = (sourcePath: string, n: number) =>
  join(dirname(sourcePath), `${basename(sourcePath, extname(sourcePath))}-수정${n === 1 ? '' : `-${n}`}${SAVE_EXTENSION}`);

/** 기본 이름 다음 번호(<이름>-수정.hwpx → -수정-2, -수정-2 → -수정-3) */
function nextNumbered(path: string): string {
  const match = /-수정(?:-(\d+))?\.hwpx$/.exec(path);
  if (match === null) throw new Error(`기본 저장 이름이 아닙니다: ${path}`);
  const n = match[1] === undefined ? 1 : Number(match[1]);
  return `${path.slice(0, match.index)}-수정-${n + 1}${SAVE_EXTENSION}`;
}

/** 원본 옆 <이름>-수정.hwpx. 이미 있으면 -수정-2, -수정-3 … 중 처음 비어 있는 것 */
async function defaultPath(sourcePath: string): Promise<string> {
  for (let n = 1; ; n += 1) {
    const candidate = numberedPath(sourcePath, n);
    if ((await statOf(candidate)) === undefined) return candidate;
  }
}

/**
 * 두 경로가 같은 파일인지. 둘 다 있으면 링크를 따라간 장치·inode 로(심볼릭·하드 링크, 대소문자만 다른 경로도 같다),
 * 아니면 경로 글자로
 */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [first, second] = await Promise.all([statOf(a), statOf(b)]);
  if (first !== undefined && second !== undefined) return first.dev === second.dev && first.ino === second.ino;
  return a === b;
}

/** .hwp 원본은 overwrite 여도 덮어쓰지 않는다 */
const hwpSourceMessage = async (sourcePath: string) =>
  `원본(${extname(sourcePath)})은 덮어쓸 수 없습니다. 저장은 항상 HWPX 입니다. path 를 빼면 ${basename(await defaultPath(sourcePath))} 로 저장합니다.`;

/** 덮어쓰면 안 되는 원본(.hwpx 가 아닌 원본). .hwpx 원본은 overwrite 로 덮어쓸 수 있다 */
export const protectedSource = (sourcePath: string): string | undefined =>
  extname(sourcePath).toLowerCase() === SAVE_EXTENSION ? undefined : sourcePath;

/** 저장할 절대 경로. 규칙에 맞지 않으면 사용자에게 보일 이유로 던진다 */
export async function resolveSavePath(request: SavePathRequest, home = homedir()): Promise<string> {
  const { sourcePath, overwrite } = request;
  if (request.path === undefined) return defaultPath(sourcePath);
  const given = absolutePath(request.path, dirname(sourcePath), home);
  // 폴더를 먼저 본다. 확장자를 붙인 뒤에 보면 ~/Downloads 가 ~/Downloads.hwpx 가 된다
  if (request.path.endsWith('/') || (await statOf(given))?.isDirectory() === true) throw new Error(folderMessage(given));
  const hwpSource = protectedSource(sourcePath);
  // 원본 경로를 그대로 준 경우(.hwp 라 아래 확장자 검사에 걸리기 전에 이유를 알린다)
  if (hwpSource !== undefined && (await sameFile(given, hwpSource))) throw new Error(await hwpSourceMessage(hwpSource));
  const extension = extname(given);
  if (extension !== '' && extension.toLowerCase() !== SAVE_EXTENSION) {
    throw new Error(`HWPX 로만 저장합니다(${extension}). 경로를 .hwpx 로 끝내거나 확장자를 빼세요.`);
  }
  const path = extension === '' ? given + SAVE_EXTENSION : given;
  // .hwpx 이름의 링크(심볼릭·하드)가 .hwp 원본을 가리킬 수 있다 — 붙인 뒤의 경로로 다시 본다
  if (hwpSource !== undefined && (await sameFile(path, hwpSource))) throw new Error(await hwpSourceMessage(hwpSource));
  const folder = await statOf(dirname(path));
  if (folder === undefined || !folder.isDirectory()) throw new Error(`저장할 폴더가 없습니다: ${dirname(path)}`);
  const existing = await statOf(path);
  if (existing === undefined) return path;
  if (existing.isDirectory()) throw new Error(folderMessage(path));
  if (!overwrite) {
    if (await sameFile(path, sourcePath)) throw new Error(`원본 파일입니다: ${path}. 덮어쓰려면 overwrite: true 를 주세요.`);
    throw new Error(existingFileMessage(path));
  }
  return path;
}

export interface SaveTarget {
  path: string;
  overwrite: boolean;
  /** 기본 이름이면 그사이 같은 이름이 생겼을 때 다음 번호로 다시 시도한다 */
  numbered: boolean;
  /** 덮어쓰면 안 되는 원본(.hwp). 덮어쓰기 직전에 대상이 이 파일인지 다시 본다(경로를 정한 뒤 바뀐 링크) */
  protectedPath?: string;
}

const errorCode = (error: unknown) => (error instanceof Error && 'code' in error ? error.code : undefined);
const isAlreadyExists = (error: unknown) => errorCode(error) === 'EEXIST';
/** 하드 링크를 못 만드는 파일 시스템(exFAT·FAT 외장 디스크 등)의 오류 */
const LINK_UNSUPPORTED = ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'];

/**
 * 이미 있으면 EEXIST 로 실패하는 배타적 만들기. 하드 링크(원자적)를 먼저 쓰고,
 * 링크를 못 만드는 파일 시스템이면 COPYFILE_EXCL 복사로(배타적이지만 복사 중에는 덜 쓴 파일이 보일 수 있다)
 */
async function createExclusively(temporary: string, path: string): Promise<void> {
  try {
    await link(temporary, path);
  } catch (error) {
    if (!LINK_UNSUPPORTED.includes(String(errorCode(error)))) throw error;
    try {
      await copyFile(temporary, path, constants.COPYFILE_EXCL);
    } catch (copyError) {
      // EEXIST 가 아니면 우리가 만든 대상이다(EXCL 은 이미 있으면 만들지 않는다). 반쯤 쓴 파일을 남기지 않는다
      if (!isAlreadyExists(copyError)) await rm(path, { force: true }).catch(() => undefined);
      throw copyError;
    }
  }
}

/**
 * 파일을 쓰고 실제로 쓴 경로를 돌려준다. 쓸 자리 폴더의 임시 파일에 다 쓴 뒤
 * - overwrite: 이름을 바꿔 한 번에 바꾼다(쓰다 실패해도 기존 파일이 반쯤 바뀌지 않는다). 기존 파일 권한을 유지하고,
 *   심볼릭 링크면 링크는 두고 실제 파일을 바꾼다(임시 파일도 실제 파일 폴더에 — 다른 디스크면 이름 바꾸기가 안 된다).
 *   바꾸기 직전에 대상이 덮으면 안 되는 원본(.hwp)인지 다시 본다
 * - 아니면: 하드 링크(안 되는 파일 시스템이면 COPYFILE_EXCL 복사)로 배타적으로 만든다(이미 있으면 실패 — 동시 저장·그사이 생긴 파일을 덮지 않는다). 기본 이름이면 다음 번호로, 지정 경로면 "이미 있는 파일" 오류
 * 실패하면 임시 파일을 지우고 "저장하지 못했습니다: <이유>" 로 던진다(이미 있는 파일·원본 오류는 그대로)
 */
export async function writeSave(target: SaveTarget, bytes: Uint8Array): Promise<string> {
  const real = target.overwrite ? await realpath(target.path).catch(() => target.path) : target.path;
  if (target.overwrite && target.protectedPath !== undefined && (await sameFile(real, target.protectedPath))) {
    throw new Error(await hwpSourceMessage(target.protectedPath));
  }
  const temporary = join(dirname(real), `.${basename(real)}.${randomUUID().slice(0, 8)}.docbridge-tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    if (target.overwrite) {
      await replaceWith(temporary, real);
      return target.path;
    }
    return await linkExclusively(temporary, target);
  } catch (error) {
    if (error instanceof ExistingFileError) throw error;
    throw new Error(`저장하지 못했습니다: ${errorMessage(error)}`);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

class ExistingFileError extends Error {}

/** real(링크를 따라간 실제 파일 자리)을 임시 파일로 바꾼다. 기존 권한 유지 */
async function replaceWith(temporary: string, real: string): Promise<void> {
  const existing = await statOf(real);
  if (existing !== undefined) await chmod(temporary, existing.mode & 0o7777);
  await rename(temporary, real);
}

async function linkExclusively(temporary: string, target: SaveTarget): Promise<string> {
  for (let path = target.path; ; path = nextNumbered(path)) {
    try {
      await createExclusively(temporary, path);
      return path;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (!target.numbered) throw new ExistingFileError(existingFileMessage(path));
    }
  }
}
