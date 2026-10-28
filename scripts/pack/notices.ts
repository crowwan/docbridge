// .mcpb 의 THIRD_PARTY_NOTICES.txt(SPEC-004): 서버 번들에 들어간 패키지와 그 라이선스 전문
import { readdir, readFile } from 'node:fs/promises';

export interface BundledPackage {
  name: string;
  /** 레포 기준 패키지 폴더(끝에 /). 중첩된 패키지는 바깥 패키지 아래의 실제 폴더 */
  dir: string;
}

/** 경로의 마지막 node_modules/<이름>/ 까지(이름은 @범위/이름 포함) */
const lastPackage = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+)\/)/;

/**
 * esbuild metafile 입력 경로(레포 기준)에서 번들에 든 패키지를 모은다(이름 → 폴더 순).
 * 중첩된 node_modules 는 마지막 것 기준이라 그 버전의 실제 폴더에서 라이선스를 읽는다(PR #97 리뷰)
 */
export function bundledPackages(inputs: string[]): BundledPackage[] {
  const packages = new Map<string, BundledPackage>();
  for (const input of inputs) {
    const match = lastPackage.exec(input);
    const dir = match?.[1];
    const name = match?.[2];
    if (dir !== undefined && name !== undefined) packages.set(dir, { name, dir });
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir));
}

/** 패키지마다 "## 이름" + 라이선스 전문. 라이선스 파일이 없으면 실패한다(빠진 채 배포하지 않게) */
export async function thirdPartyNotices(packages: BundledPackage[], root: string): Promise<string> {
  const sections = await Promise.all(
    packages.map(async ({ name, dir }) => {
      const licenseFile = (await readdir(`${root}${dir}`)).find((file) => /^licen[cs]e/i.test(file));
      if (licenseFile === undefined) throw new Error(`라이선스 파일이 없습니다: ${name} (${dir})`);
      return `## ${name}\n\n${(await readFile(`${root}${dir}${licenseFile}`, 'utf8')).trim()}\n`;
    }),
  );
  return `docbridge 의 server/index.js · viewer/ 에 함께 묶인 패키지와 라이선스\n\n${sections.join('\n')}`;
}
