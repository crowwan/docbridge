import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { packageVersion, REPO_ROOT } from '../scripts/pack/manifest.ts';
import { releaseFile } from '../scripts/release/tag.ts';

const run = promisify(execFile);
const checkTag = `${REPO_ROOT}scripts/release/check-tag.ts`;

describe('SPEC-004 릴리스 태그와 버전 (Release 워크플로)', () => {
  it('태그가 v<package.json 버전> 이면 Release 에 올릴 파일 dist/docbridge-<버전>.mcpb 를 돌려준다', () => {
    expect(releaseFile('v0.2.0', '0.2.0')).toBe('dist/docbridge-0.2.0.mcpb');
    expect(releaseFile('v1.10.3-rc.1', '1.10.3-rc.1')).toBe('dist/docbridge-1.10.3-rc.1.mcpb');
  });

  it('태그와 package.json 버전이 다르면 실패한다(버전 올리기를 빼먹은 태그로 엉뚱한 버전의 .mcpb 를 올리지 않게)', () => {
    const mismatch = '태그 v0.2.0 와 package.json 버전 0.1.0 이 다릅니다. 태그는 v0.1.0 이어야 합니다';
    expect(() => releaseFile('v0.2.0', '0.1.0')).toThrow(mismatch);
    // v 를 빼거나 버전 일부만 쓴 태그도 다르다
    expect(() => releaseFile('0.2.0', '0.2.0')).toThrow('태그는 v0.2.0 이어야 합니다');
    expect(() => releaseFile('v0.2', '0.2.0')).toThrow('태그는 v0.2.0 이어야 합니다');
  });

  it('워크플로가 부르는 check-tag 는 맞는 태그면 올릴 파일 경로만 stdout 에 쓰고, 다르면 이유를 stderr 에 쓰고 실패한다', async () => {
    const version = await packageVersion();

    const ok = await run(process.execPath, [checkTag, `v${version}`], { cwd: REPO_ROOT });
    expect(ok.stdout).toBe(`dist/docbridge-${version}.mcpb\n`);

    const failed = run(process.execPath, [checkTag, 'v999.0.0'], { cwd: REPO_ROOT });
    await expect(failed).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringContaining(`태그 v999.0.0 와 package.json 버전 ${version} 이 다릅니다`),
    });
  });

  it('check-tag 에 태그를 주지 않으면 실패한다', async () => {
    await expect(run(process.execPath, [checkTag], { cwd: REPO_ROOT })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('태그를 주세요'),
    });
  });
});
