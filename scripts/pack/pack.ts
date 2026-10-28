// Claude Desktop 확장(.mcpb) 만들기(SPEC-004). 실행: npm run pack (뷰어 빌드 후 이 스크립트)
// dist/mcpb/ 에 manifest.json · server/index.js(의존성까지 한 파일) · viewer/(dist/viewer 그대로, rhwp WASM 포함) ·
// LICENSE · THIRD_PARTY_NOTICES.txt(번들에 든 패키지의 라이선스 전문)를 모으고 mcpb validate → mcpb pack 으로 dist/docbridge-<버전>.mcpb 를 만든다.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { build, type Metafile } from 'esbuild';
import { buildManifest, mcpbPath, packageVersion, REPO_ROOT, registeredTools } from './manifest.ts';

const stageDir = `${REPO_ROOT}dist/mcpb/`;
const mcpb = `${REPO_ROOT}node_modules/.bin/mcpb`;

/** 번들 target: Claude Desktop 에 든 Node(24.22.0) 와 같은 큰 버전 */
const NODE_TARGET = 'node24';

/** 서버를 의존성까지 ESM 한 파일로 묶는다. 서버는 rhwp WASM 을 띄우지 않는다(rhwp 는 뷰어에서만 돈다 — 번들에는 JS 글루만 들어간다) */
async function bundleServer(): Promise<Metafile> {
  const { metafile } = await build({
    entryPoints: [`${REPO_ROOT}src/server/index.ts`],
    outfile: `${stageDir}server/index.js`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: NODE_TARGET,
    // ws 같은 CommonJS 의존성이 require('events') 등을 부르므로 ESM 번들에 require 를 만들어 둔다
    banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
    // ws 의 선택 의존성(네이티브 가속). 없으면 ws 가 알아서 건너뛴다
    external: ['bufferutil', 'utf-8-validate'],
    metafile: true,
    logLevel: 'warning',
  });
  return metafile;
}

/** 번들에 들어간 node_modules 패키지 폴더들(이름순). 뷰어가 쓰는 패키지(@rhwp/core·zod)도 서버 번들에 들어 있다 */
function bundledPackages(metafile: Metafile): string[] {
  const packages = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (match?.[1] !== undefined) packages.add(match[1]);
  }
  return [...packages].sort();
}

async function thirdPartyNotices(packages: string[]): Promise<string> {
  const sections = await Promise.all(
    packages.map(async (name) => {
      const dir = `${REPO_ROOT}node_modules/${name}/`;
      const licenseFile = (await readdir(dir)).find((file) => /^licen[cs]e/i.test(file));
      if (licenseFile === undefined) throw new Error(`라이선스 파일이 없습니다: ${name}`);
      return `## ${name}\n\n${(await readFile(`${dir}${licenseFile}`, 'utf8')).trim()}\n`;
    }),
  );
  return `docbridge 의 server/index.js · viewer/ 에 함께 묶인 패키지와 라이선스\n\n${sections.join('\n')}`;
}

const version = await packageVersion();
await rm(stageDir, { recursive: true, force: true });
await mkdir(stageDir, { recursive: true });
const metafile = await bundleServer();
// 서버는 server/index.js 기준 ../viewer/ 를 내준다(src/server/index.ts)
await cp(`${REPO_ROOT}dist/viewer`, `${stageDir}viewer`, { recursive: true });
await cp(`${REPO_ROOT}LICENSE`, `${stageDir}LICENSE`);
await writeFile(`${stageDir}THIRD_PARTY_NOTICES.txt`, await thirdPartyNotices(bundledPackages(metafile)));
await writeFile(`${stageDir}manifest.json`, `${JSON.stringify(buildManifest(version, await registeredTools()), null, 2)}\n`);

execFileSync(mcpb, ['validate', `${stageDir}manifest.json`], { stdio: 'inherit' });
const output = mcpbPath(version);
await rm(output, { force: true });
execFileSync(mcpb, ['pack', stageDir, output], { stdio: 'inherit' });
const { size } = await stat(output);
process.stderr.write(`만들었습니다: ${output} (${(size / 1024 / 1024).toFixed(1)}MB)\n`);
