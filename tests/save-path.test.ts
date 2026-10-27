import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveSavePath, writeSave } from '../src/server/save-path.ts';
import { fixturePath } from './fixtures.ts';

describe('SPEC-002 저장 경로 정하기 (save_document 경로 규칙)', () => {
  let dir: string;
  let home: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'docbridge-save-path-'));
    home = await mkdtemp(join(tmpdir(), 'docbridge-home-'));
  });

  const source = async (name: string) => {
    const path = join(dir, name);
    await copyFile(fixturePath(name.endsWith('.hwp') ? 'notice.hwp' : 'notice.hwpx'), path);
    return path;
  };

  it('경로가 없으면 원본과 같은 폴더의 <원본 이름>-수정.hwpx 로 저장한다', async () => {
    const sourcePath = await source('공문.hwpx');

    expect(await resolveSavePath({ sourcePath, overwrite: false }, home)).toBe(join(dir, '공문-수정.hwpx'));
  });

  it('원본이 .hwp 여도 기본 경로는 .hwpx 다', async () => {
    const sourcePath = await source('공문.hwp');

    expect(await resolveSavePath({ sourcePath, overwrite: false }, home)).toBe(join(dir, '공문-수정.hwpx'));
  });

  it('기본 이름의 파일이 이미 있으면 -수정-2, -수정-3 … 으로 번호를 붙인다', async () => {
    const sourcePath = await source('공문.hwpx');
    await writeFile(join(dir, '공문-수정.hwpx'), '');
    await writeFile(join(dir, '공문-수정-2.hwpx'), '');

    expect(await resolveSavePath({ sourcePath, overwrite: false }, home)).toBe(join(dir, '공문-수정-3.hwpx'));
  });

  it('상대 경로는 원본 폴더 기준, ~/ 는 홈 폴더 기준으로 바꾼다', async () => {
    const sourcePath = await source('공문.hwpx');
    await mkdir(join(dir, '보낼 것'));

    expect(await resolveSavePath({ sourcePath, path: '보낼 것/회신.hwpx', overwrite: false }, home)).toBe(join(dir, '보낼 것', '회신.hwpx'));
    expect(await resolveSavePath({ sourcePath, path: '~/회신.hwpx', overwrite: false }, home)).toBe(join(home, '회신.hwpx'));
  });

  it('확장자가 없으면 .hwpx 를 붙이고, .hwpx 가 아닌 확장자는 거부한다', async () => {
    const sourcePath = await source('공문.hwpx');

    expect(await resolveSavePath({ sourcePath, path: '회신', overwrite: false }, home)).toBe(join(dir, '회신.hwpx'));
    expect(await resolveSavePath({ sourcePath, path: '회신.HWPX', overwrite: false }, home)).toBe(join(dir, '회신.HWPX'));
    await expect(resolveSavePath({ sourcePath, path: '회신.docx', overwrite: false }, home)).rejects.toThrow(
      'HWPX 로만 저장합니다(.docx). 경로를 .hwpx 로 끝내거나 확장자를 빼세요.',
    );
  });

  it('원본 .hwpx 는 overwrite: true 일 때만 덮어쓴다', async () => {
    const sourcePath = await source('공문.hwpx');

    await expect(resolveSavePath({ sourcePath, path: sourcePath, overwrite: false }, home)).rejects.toThrow(
      `원본 파일입니다: ${sourcePath}. 덮어쓰려면 overwrite: true 를 주세요.`,
    );
    expect(await resolveSavePath({ sourcePath, path: sourcePath, overwrite: true }, home)).toBe(sourcePath);
  });

  it('원본이 .hwp 면 overwrite: true 여도 원본을 덮어쓰지 않는다', async () => {
    const sourcePath = await source('공문.hwp');

    await expect(resolveSavePath({ sourcePath, path: sourcePath, overwrite: true }, home)).rejects.toThrow(
      '원본(.hwp)은 덮어쓸 수 없습니다. 저장은 항상 HWPX 입니다. path 를 빼면 공문-수정.hwpx 로 저장합니다.',
    );
  });

  it('원본 .hwp 를 가리키는 링크(.hwpx 이름의 심볼릭·하드 링크)도 원본으로 보고 덮어쓰지 않는다', async () => {
    const sourcePath = await source('공문.hwp');
    await symlink(sourcePath, join(dir, '공문-link.hwpx'));
    await link(sourcePath, join(dir, '공문-hard.hwpx'));

    for (const path of ['공문-link.hwpx', '공문-link', '공문-hard.hwpx']) {
      await expect(resolveSavePath({ sourcePath, path, overwrite: true }, home)).rejects.toThrow(
        '원본(.hwp)은 덮어쓸 수 없습니다. 저장은 항상 HWPX 입니다. path 를 빼면 공문-수정.hwpx 로 저장합니다.',
      );
    }
  });

  it('쓰기 직전에도 원본 .hwp 를 다시 확인한다(경로를 정한 뒤 원본을 가리키게 바뀐 링크)', async () => {
    const sourcePath = await source('공문.hwp');
    const path = join(dir, '회신.hwpx');
    await symlink(sourcePath, path);

    await expect(writeSave({ path, overwrite: true, numbered: false, protectedPath: sourcePath }, new TextEncoder().encode('새 내용'))).rejects.toThrow(
      '원본(.hwp)은 덮어쓸 수 없습니다.',
    );
    expect(await readFile(sourcePath)).toEqual(await readFile(fixturePath('notice.hwp')));
  });

  it('이미 있는 다른 파일은 overwrite: true 일 때만 덮어쓴다', async () => {
    const sourcePath = await source('공문.hwpx');
    const other = join(dir, '회신.hwpx');
    await writeFile(other, '');

    await expect(resolveSavePath({ sourcePath, path: other, overwrite: false }, home)).rejects.toThrow(
      `이미 있는 파일입니다: ${other}. 덮어쓰려면 overwrite: true 를 주세요.`,
    );
    expect(await resolveSavePath({ sourcePath, path: other, overwrite: true }, home)).toBe(other);
  });

  it('확장자 없이 폴더를 가리키면(끝 / 포함) .hwpx 를 붙이지 않고 폴더라고 거부한다', async () => {
    const sourcePath = await source('공문.hwpx');
    await mkdir(join(home, 'Downloads'));
    await mkdir(join(dir, 'out'));

    await expect(resolveSavePath({ sourcePath, path: '~/Downloads', overwrite: false }, home)).rejects.toThrow(
      `폴더입니다: ${join(home, 'Downloads')}. 파일 경로를 주세요.`,
    );
    await expect(resolveSavePath({ sourcePath, path: 'out/', overwrite: false }, home)).rejects.toThrow(
      `폴더입니다: ${join(dir, 'out')}. 파일 경로를 주세요.`,
    );
    await expect(resolveSavePath({ sourcePath, path: '없는폴더/', overwrite: false }, home)).rejects.toThrow(
      `폴더입니다: ${join(dir, '없는폴더')}. 파일 경로를 주세요.`,
    );
  });

  it('확장자 없이 원본을 가리켜도 원본으로 본다', async () => {
    const sourcePath = await source('공문.hwpx');

    await expect(resolveSavePath({ sourcePath, path: '공문', overwrite: false }, home)).rejects.toThrow(
      `원본 파일입니다: ${sourcePath}. 덮어쓰려면 overwrite: true 를 주세요.`,
    );
  });

  it('폴더가 없거나 경로가 폴더면 거부한다', async () => {
    const sourcePath = await source('공문.hwpx');
    await mkdir(join(dir, '폴더.hwpx'));

    await expect(resolveSavePath({ sourcePath, path: '없는 폴더/회신.hwpx', overwrite: false }, home)).rejects.toThrow(
      `저장할 폴더가 없습니다: ${join(dir, '없는 폴더')}`,
    );
    await expect(resolveSavePath({ sourcePath, path: '폴더.hwpx', overwrite: true }, home)).rejects.toThrow(
      `폴더입니다: ${join(dir, '폴더.hwpx')}. 파일 경로를 주세요.`,
    );
  });
});

describe('SPEC-002 저장 파일 쓰기 (임시 파일 → 배타적 만들기·이름 바꾸기)', () => {
  let dir: string;
  const bytes = (text: string) => new TextEncoder().encode(text);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'docbridge-write-'));
  });

  it('overwrite 면 임시 파일에 쓴 뒤 이름을 바꿔 기존 파일을 한 번에 바꾸고 임시 파일을 남기지 않는다', async () => {
    const path = join(dir, '회신.hwpx');
    await writeFile(path, '옛 내용');

    expect(await writeSave({ path, overwrite: true, numbered: false }, bytes('새 내용'))).toBe(path);

    expect(await readFile(path, 'utf8')).toBe('새 내용');
    expect(await readdir(dir)).toEqual(['회신.hwpx']);
  });

  it('덮어쓰지 않는 저장을 동시에 두 번 하면 서로 덮지 않고 기본 이름의 다음 번호로 저장한다', async () => {
    const path = join(dir, '공문-수정.hwpx');

    const written = await Promise.all([
      writeSave({ path, overwrite: false, numbered: true }, bytes('첫째')),
      writeSave({ path, overwrite: false, numbered: true }, bytes('둘째')),
    ]);

    expect(written.toSorted()).toEqual([join(dir, '공문-수정-2.hwpx'), path]);
    expect((await Promise.all(written.map((p) => readFile(p, 'utf8')))).toSorted()).toEqual(['둘째', '첫째']);
    expect((await readdir(dir)).toSorted()).toEqual(['공문-수정-2.hwpx', '공문-수정.hwpx']);
  });

  it('경로를 정한 뒤 같은 이름의 파일이 생기면 overwrite 가 아닌 지정 경로는 덮지 않고 거부한다', async () => {
    const path = join(dir, '회신.hwpx');
    await writeFile(path, '다른 프로그램이 만든 파일');

    await expect(writeSave({ path, overwrite: false, numbered: false }, bytes('새 내용'))).rejects.toThrow(
      `이미 있는 파일입니다: ${path}. 덮어쓰려면 overwrite: true 를 주세요.`,
    );
    expect(await readFile(path, 'utf8')).toBe('다른 프로그램이 만든 파일');
    expect(await readdir(dir)).toEqual(['회신.hwpx']);
  });

  it('덮어쓸 때 기존 파일의 권한을 유지한다', async () => {
    const path = join(dir, '회신.hwpx');
    await writeFile(path, '옛 내용');
    await chmod(path, 0o640);

    await writeSave({ path, overwrite: true, numbered: false }, bytes('새 내용'));

    expect((await stat(path)).mode & 0o777).toBe(0o640);
  });

  it('대상이 심볼릭 링크면 링크는 그대로 두고 실제 파일을 바꾼다', async () => {
    const real = join(dir, '실제.hwpx');
    const link = join(dir, '링크.hwpx');
    await writeFile(real, '옛 내용');
    await symlink(real, link);

    expect(await writeSave({ path: link, overwrite: true, numbered: false }, bytes('새 내용'))).toBe(link);

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf8')).toBe('새 내용');
  });

  it('쓰기 권한이 없으면 이유를 담아 실패하고 파일을 만들지 않는다', async () => {
    await chmod(dir, 0o555);

    await expect(writeSave({ path: join(dir, '회신.hwpx'), overwrite: false, numbered: false }, new Uint8Array([1]))).rejects.toThrow(
      /^저장하지 못했습니다: .*EACCES/,
    );

    await chmod(dir, 0o755);
    expect(await readdir(dir)).toEqual([]);
  });

  it('이름 바꾸기가 실패하면 임시 파일을 지운다', async () => {
    // 같은 이름의 폴더가 있으면 파일을 그 자리로 옮길 수 없다
    await mkdir(join(dir, '회신.hwpx', '안'), { recursive: true });

    await expect(writeSave({ path: join(dir, '회신.hwpx'), overwrite: true, numbered: false }, new Uint8Array([1]))).rejects.toThrow(
      /^저장하지 못했습니다: /,
    );

    expect(await readdir(dir)).toEqual(['회신.hwpx']);
  });
});
