// .mcpb 의 THIRD_PARTY_NOTICES.txt(SPEC-004): 서버 번들에 들어간 패키지와 그 라이선스 전문
import { readdir, readFile } from 'node:fs/promises';
import { z } from 'zod';

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

/**
 * 패키지 안에 함께 묶였거나(rollup 번들 등) 옮겨 온 코드의 고지: scripts/pack/licenses/<이름, / 는 __>.bundled.txt — 그 패키지 라이선스 뒤에 붙는다.
 * esbuild metafile 에는 바깥 패키지 하나로만 보여 notices 가 모으지 못하고, 원래 주석도 압축 번들에서 빠진다(#114).
 * 첫 줄 "확인한 판: <이름>@<판>" — 패키지를 올리면 안에 든 것이 바뀌므로 다시 확인하게 판이 다르면 실패한다
 */
const bundledPath = (root: string, name: string) => `${root}scripts/pack/licenses/${name.replace('/', '__')}.bundled.txt`;

/** 함께 묶인 코드 고지에 적힌 확인한 판이 설치된 판과 같은지. 다르거나 없으면 던진다 */
export function checkBundledVersion(name: string, text: string, installed: string): void {
  const prefix = `확인한 판: ${name}@`;
  const line = text.split('\n').find((candidate) => candidate.startsWith(prefix));
  const file = `scripts/pack/licenses/${name.replace('/', '__')}.bundled.txt`;
  if (line === undefined) throw new Error(`${file} 첫 줄에 "${prefix}<판>" 이 없습니다`);
  const checked = line.slice(prefix.length).trim();
  if (checked !== installed) {
    throw new Error(`${name} 의 함께 묶인 코드 고지는 ${checked} 판을 확인한 것입니다(설치된 판 ${installed}). ${file} 를 다시 확인하세요`);
  }
}

const packageVersionSchema = z.object({ version: z.string() });

/** 함께 묶인 코드 고지(없으면 빈 글). 있으면 판을 확인한다 */
async function bundledNotice(root: string, name: string, dir: string): Promise<string> {
  const text = await readFile(bundledPath(root, name), 'utf8').catch(() => undefined);
  if (text === undefined) return '';
  const { version } = packageVersionSchema.parse(JSON.parse(await readFile(`${root}${dir}package.json`, 'utf8')));
  checkBundledVersion(name, text, version);
  return `\n\n${text.trim()}`;
}

/** 패키지마다 "## 이름" + 라이선스 전문(+ 함께 묶인 코드 고지). 라이선스 파일도 보충 고지도 없으면 실패한다(빠진 채 배포하지 않게) */
export async function thirdPartyNotices(packages: BundledPackage[], root: string): Promise<string> {
  const sections = await Promise.all(
    packages.map(async ({ name, dir }) => {
      const licenseFile = (await readdir(`${root}${dir}`)).find((file) => /^licen[cs]e/i.test(file));
      const path = licenseFile === undefined ? supplementPath(root, name) : `${root}${dir}${licenseFile}`;
      const text = await readFile(path, 'utf8').catch(() => {
        throw new Error(`라이선스 파일이 없습니다: ${name} (${dir})`);
      });
      return `## ${name}\n\n${text.trim()}${await bundledNotice(root, name, dir)}\n`;
    }),
  );
  return `docbridge 의 server/index.js · viewer/ 에 함께 묶인 패키지와 라이선스\n\n${sections.join('\n')}`;
}
