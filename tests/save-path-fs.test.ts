// 파일 시스템 동작을 흉내내야 하는 저장 쓰기 경우: 하드 링크가 안 되는 파일 시스템(exFAT 등), 복사 중 실패,
// 다른 디스크로의 이름 바꾸기(EXDEV). node:fs/promises 의 link·copyFile·rename 만 바꾸고 나머지는 진짜를 쓴다.
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeSave } from '../src/server/save-path.ts';

const fake = vi.hoisted(() => ({
  linkFails: false,
  copyFailsAfterWriting: false,
  /** 이름 바꾸기가 다른 폴더(= 다른 디스크로 본다) 사이면 EXDEV */
  renameAcrossFoldersFails: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const { dirname: folderOf } = await import('node:path');
  const fail = (code: string) => Object.assign(new Error(`${code}: 흉내낸 실패`), { code });
  return {
    ...original,
    link: async (from: string, to: string) => {
      if (fake.linkFails) throw fail('EPERM');
      return original.link(from, to);
    },
    copyFile: async (from: string, to: string, mode?: number) => {
      if (fake.copyFailsAfterWriting) {
        await original.writeFile(to, '반쯤 쓴 내용', { flag: 'wx' });
        throw fail('ENOSPC');
      }
      return original.copyFile(from, to, mode);
    },
    rename: async (from: string, to: string) => {
      if (fake.renameAcrossFoldersFails && folderOf(from) !== folderOf(to)) throw fail('EXDEV');
      return original.rename(from, to);
    },
  };
});

const bytes = (text: string) => new TextEncoder().encode(text);

describe('SPEC-002 저장 파일 쓰기 (파일 시스템 흉내)', () => {
  let dir: string;

  beforeEach(async () => {
    fake.linkFails = false;
    fake.copyFailsAfterWriting = false;
    fake.renameAcrossFoldersFails = false;
    dir = await mkdtemp(join(tmpdir(), 'docbridge-fs-'));
  });

  it('하드 링크가 안 되면 복사로 배타적으로 만들고, 기본 이름이 있으면 다음 번호로 저장한다', async () => {
    fake.linkFails = true;
    const path = join(dir, '공문-수정.hwpx');
    await writeFile(path, '먼저 있던 파일');

    const written = await writeSave({ path, overwrite: false, numbered: true }, bytes('새 내용'));

    expect(written).toBe(join(dir, '공문-수정-2.hwpx'));
    expect(await readFile(path, 'utf8')).toBe('먼저 있던 파일');
    expect(await readFile(written, 'utf8')).toBe('새 내용');
    expect((await readdir(dir)).toSorted()).toEqual(['공문-수정-2.hwpx', '공문-수정.hwpx']);
  });

  it('복사가 중간에 실패하면 반쯤 쓴 파일을 남기지 않는다', async () => {
    fake.linkFails = true;
    fake.copyFailsAfterWriting = true;

    await expect(writeSave({ path: join(dir, '회신.hwpx'), overwrite: false, numbered: false }, bytes('새 내용'))).rejects.toThrow(
      /^저장하지 못했습니다: ENOSPC/,
    );

    expect(await readdir(dir)).toEqual([]);
  });

  it('덮어쓸 대상이 다른 디스크의 파일을 가리키는 심볼릭 링크여도 실제 파일 옆에서 이름을 바꿔 저장한다', async () => {
    fake.renameAcrossFoldersFails = true;
    const other = join(dir, '다른 디스크');
    await mkdir(other);
    const real = join(other, '실제.hwpx');
    await writeFile(real, '옛 내용');
    const linkPath = join(dir, '링크.hwpx');
    await symlink(real, linkPath);

    await writeSave({ path: linkPath, overwrite: true, numbered: false }, bytes('새 내용'));

    expect(await readFile(real, 'utf8')).toBe('새 내용');
    expect(await readdir(dir)).toEqual(['링크.hwpx', '다른 디스크'].toSorted());
    expect(await readdir(dirname(real))).toEqual(['실제.hwpx']);
  });
});
