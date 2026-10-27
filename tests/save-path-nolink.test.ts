// 하드 링크를 못 만드는 파일 시스템(exFAT 등)을 흉내낸다: link 만 EPERM 으로 바꾼다
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { writeSave } from '../src/server/save-path.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    link: async () => {
      throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' });
    },
  };
});

describe('SPEC-002 저장 파일 쓰기 (하드 링크가 안 되는 파일 시스템)', () => {
  it('복사로 배타적으로 만들고, 기본 이름이 있으면 다음 번호로 저장한다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docbridge-nolink-'));
    const path = join(dir, '공문-수정.hwpx');
    await writeFile(path, '먼저 있던 파일');

    const written = await writeSave({ path, overwrite: false, numbered: true }, new TextEncoder().encode('새 내용'));

    expect(written).toBe(join(dir, '공문-수정-2.hwpx'));
    expect(await readFile(path, 'utf8')).toBe('먼저 있던 파일');
    expect(await readFile(written, 'utf8')).toBe('새 내용');
    expect((await readdir(dir)).toSorted()).toEqual(['공문-수정-2.hwpx', '공문-수정.hwpx']);
  });
});
