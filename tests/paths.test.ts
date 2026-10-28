// 경로 규칙을 플랫폼별 path(path.win32·path.posix)로 검증한다. 파일 시스템이 필요한 realFilePath 는 지금 플랫폼에서만.
import { mkdtemp, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { absolutePath, isAbsoluteInput, realFilePath } from '../src/server/paths.ts';
import { RELATIVE_NEW_PATH, defaultSaveName, isFolderInput, requireAbsolutePath, withSaveExtension } from '../src/server/save-path.ts';

const WIN_HOME = 'C:\\Users\\민지';

describe('SPEC-004 경로 규칙 — 윈도우 경로 (path.win32)', () => {
  it.each([
    ['~', WIN_HOME],
    ['~\\보고서.hwpx', `${WIN_HOME}\\보고서.hwpx`],
    ['~/보고서.hwpx', `${WIN_HOME}\\보고서.hwpx`],
  ])('~ 펼치기: %s 는 홈 폴더 기준이다', (raw, expected) => {
    expect(absolutePath(raw, 'D:\\받은 문서', WIN_HOME, win32)).toBe(expected);
  });

  it.each([
    ['C:\\문서\\공문.hwpx', 'C:\\문서\\공문.hwpx'],
    ['C:/문서/공문.hwpx', 'C:\\문서\\공문.hwpx'],
    ['C:\\문서/보낼 것\\공문.hwpx', 'C:\\문서\\보낼 것\\공문.hwpx'],
    ['\\\\server\\share\\공문.hwpx', '\\\\server\\share\\공문.hwpx'],
  ])('절대 경로 %s 는 그대로(/ 섞임은 \\ 로 맞춰) 쓴다', (raw, expected) => {
    expect(isAbsoluteInput(raw, win32)).toBe(true);
    expect(absolutePath(raw, 'D:\\받은 문서', WIN_HOME, win32)).toBe(expected);
  });

  it.each(['보낼 것\\회신.hwpx', '회신.hwpx', 'C:회신.hwpx', '~민지\\회신.hwpx'])(
    '%s 는 절대 경로가 아니다(드라이브만 있는 C:이름, ~이름 포함)',
    (raw) => {
      expect(isAbsoluteInput(raw, win32)).toBe(false);
    },
  );

  it('상대 경로는 원본 폴더 기준이다', () => {
    expect(absolutePath('보낼 것\\회신.hwpx', 'D:\\받은 문서', WIN_HOME, win32)).toBe('D:\\받은 문서\\보낼 것\\회신.hwpx');
    expect(absolutePath('..\\회신.hwpx', 'D:\\받은 문서', WIN_HOME, win32)).toBe('D:\\회신.hwpx');
  });

  it('create_document path 는 절대 경로나 ~ 만 받고 상대 경로(드라이브만 있는 C:이름 포함)는 거부한다', () => {
    expect(requireAbsolutePath('C:\\문서\\제안서.hwpx', RELATIVE_NEW_PATH, WIN_HOME, win32)).toBe('C:\\문서\\제안서.hwpx');
    expect(requireAbsolutePath('~\\제안서.hwpx', RELATIVE_NEW_PATH, WIN_HOME, win32)).toBe(`${WIN_HOME}\\제안서.hwpx`);
    expect(requireAbsolutePath('\\\\server\\share\\제안서.hwpx', RELATIVE_NEW_PATH, WIN_HOME, win32)).toBe('\\\\server\\share\\제안서.hwpx');
    expect(() => requireAbsolutePath('문서\\제안서.hwpx', RELATIVE_NEW_PATH, WIN_HOME, win32)).toThrow(RELATIVE_NEW_PATH);
    expect(() => requireAbsolutePath('C:제안서.hwpx', RELATIVE_NEW_PATH, WIN_HOME, win32)).toThrow(RELATIVE_NEW_PATH);
  });

  it('기본 저장 이름은 원본 옆 <이름>-수정.hwpx, 겹치면 -수정-2', () => {
    expect(defaultSaveName('C:\\받은 문서\\공문.hwp', 1, win32)).toBe('C:\\받은 문서\\공문-수정.hwpx');
    expect(defaultSaveName('C:\\받은 문서\\공문.HWPX', 2, win32)).toBe('C:\\받은 문서\\공문-수정-2.hwpx');
    expect(defaultSaveName('\\\\server\\share\\v1.2\\공문.hwpx', 1, win32)).toBe('\\\\server\\share\\v1.2\\공문-수정.hwpx');
  });

  it('확장자 판정: 폴더 이름의 점은 확장자가 아니다(없으면 .hwpx 를 붙인다), .hwpx 가 아니면 거부', () => {
    expect(withSaveExtension('C:\\v1.2\\회신', win32)).toBe('C:\\v1.2\\회신.hwpx');
    expect(withSaveExtension('C:\\문서\\회신.HWPX', win32)).toBe('C:\\문서\\회신.HWPX');
    expect(() => withSaveExtension('C:\\문서\\회신.docx', win32)).toThrow('HWPX 로만 저장합니다(.docx).');
  });

  it('\\ 나 / 로 끝나는 경로는 폴더로 본다', () => {
    expect(isFolderInput('C:\\Users\\민지\\Downloads\\', win32)).toBe(true);
    expect(isFolderInput('C:/Users/민지/Downloads/', win32)).toBe(true);
    expect(isFolderInput('C:\\Users\\민지\\회신.hwpx', win32)).toBe(false);
  });
});

describe('SPEC-004 경로 규칙 — 맥·리눅스 경로 (path.posix)', () => {
  it('~ 와 ~/ 만 홈 폴더다(~\\ 는 홈이 아니라 이름의 일부)', () => {
    expect(absolutePath('~', '/받은', '/Users/민지', posix)).toBe('/Users/민지');
    expect(absolutePath('~/회신.hwpx', '/받은', '/Users/민지', posix)).toBe('/Users/민지/회신.hwpx');
    expect(absolutePath('~\\회신.hwpx', '/받은', '/Users/민지', posix)).toBe('/받은/~\\회신.hwpx');
    expect(isAbsoluteInput('~\\회신.hwpx', posix)).toBe(false);
  });

  it('C:\\… 는 posix 에서 절대 경로가 아니다', () => {
    expect(isAbsoluteInput('C:\\문서\\공문.hwpx', posix)).toBe(false);
    expect(isAbsoluteInput('/Users/민지/공문.hwpx', posix)).toBe(true);
  });

  it('기본 저장 이름·확장자·폴더 판정', () => {
    expect(defaultSaveName('/받은/공문.hwp', 1, posix)).toBe('/받은/공문-수정.hwpx');
    expect(withSaveExtension('/v1.2/회신', posix)).toBe('/v1.2/회신.hwpx');
    expect(isFolderInput('/Users/민지/Downloads/', posix)).toBe(true);
    // posix 에서 \ 는 파일 이름에 쓸 수 있는 글자다
    expect(isFolderInput('/Users/민지/이름\\', posix)).toBe(false);
  });
});

/** 지금 파일 시스템이 대소문자를 가리지 않는지(macOS 기본·윈도우 NTFS) */
async function caseInsensitiveFileSystem(dir: string): Promise<boolean> {
  await writeFile(join(dir, 'probe'), '');
  return (await stat(join(dir, 'PROBE')).catch(() => undefined)) !== undefined;
}

describe('SPEC-004 같은 파일 판정 (realFilePath, 지금 플랫폼에서만)', () => {
  it('대소문자를 가리지 않는 파일 시스템이면 대소문자만 다른 경로도 같은 실제 경로다(윈도우·macOS)', async (context) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'docbridge-case-')));
    if (!(await caseInsensitiveFileSystem(dir))) context.skip();
    await writeFile(join(dir, '공문.HWPX'), '');

    expect(await realFilePath(join(dir, '공문.hwpx'))).toBe(join(dir, '공문.HWPX'));
  });

  it('아직 없는 파일은 폴더만 따라가고 이름은 그대로 둔다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docbridge-missing-'));

    expect(await realFilePath(join(dir, '새 문서.hwpx'))).toBe(join(await realpath(dir), '새 문서.hwpx'));
  });
});
