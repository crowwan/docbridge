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

/**
 * 라이선스 파일이 없는 패키지의 보충 고지: scripts/pack/licenses/<이름, / 는 __>.txt — 사람이 package.json·README 를 확인해 넣은 것
 * (@pdf-lib/fontkit 은 MIT 라고만 적고 LICENSE 파일이 없다, #108)
 */
const supplementPath = (root: string, name: string) => `${root}scripts/pack/licenses/${name.replace('/', '__')}.txt`;

/** 패키지마다 "## 이름" + 라이선스 전문. 라이선스 파일도 보충 고지도 없으면 실패한다(빠진 채 배포하지 않게) */
export async function thirdPartyNotices(packages: BundledPackage[], root: string): Promise<string> {
  const sections = await Promise.all(
    packages.map(async ({ name, dir }) => {
      const licenseFile = (await readdir(`${root}${dir}`)).find((file) => /^licen[cs]e/i.test(file));
      const path = licenseFile === undefined ? supplementPath(root, name) : `${root}${dir}${licenseFile}`;
      const text = await readFile(path, 'utf8').catch(() => {
        throw new Error(`라이선스 파일이 없습니다: ${name} (${dir})`);
      });
      return `## ${name}\n\n${text.trim()}\n`;
    }),
  );
  return `docbridge 의 server/index.js · viewer/ 에 함께 묶인 패키지와 라이선스\n\n${sections.join('\n')}`;
}
