import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../scripts/pack/manifest.ts';
import { bundledPackages, checkBundledVersion, thirdPartyNotices } from '../scripts/pack/notices.ts';

describe('SPEC-004 THIRD_PARTY_NOTICES 패키지 모으기 (.mcpb)', () => {
  it('번들 입력 경로에서 node_modules 패키지 이름과 폴더를 모은다(@범위 패키지 포함, 내 소스는 빼고, 이름순)', () => {
    const inputs = [
      'src/server/index.ts',
      'node_modules/zod/v4/core/core.js',
      'node_modules/ws/lib/websocket.js',
      'node_modules/ws/lib/sender.js',
      'node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js',
    ];

    expect(bundledPackages(inputs)).toEqual([
      { name: '@modelcontextprotocol/sdk', dir: 'node_modules/@modelcontextprotocol/sdk/' },
      { name: 'ws', dir: 'node_modules/ws/' },
      { name: 'zod', dir: 'node_modules/zod/' },
    ]);
  });

  it('중첩된 node_modules 의 패키지는 마지막 node_modules 기준 이름과 그 실제 폴더로 모은다(바깥 패키지에 묶이지 않는다)', () => {
    // PR #97 리뷰: 첫 node_modules 만 보면 content-type 이 express 로 묶이고 라이선스도 최상위(다른 버전일 수 있음)에서 읽었다
    const inputs = [
      'node_modules/express/lib/express.js',
      'node_modules/express/node_modules/content-type/index.js',
      'node_modules/@scope/outer/node_modules/@scope/inner/index.js',
    ];

    expect(bundledPackages(inputs)).toEqual([
      { name: '@scope/inner', dir: 'node_modules/@scope/outer/node_modules/@scope/inner/' },
      { name: 'content-type', dir: 'node_modules/express/node_modules/content-type/' },
      { name: 'express', dir: 'node_modules/express/' },
    ]);
  });

  it('패키지마다 "## 이름" 아래 그 폴더의 라이선스 전문을 붙이고, 라이선스 파일이 없으면 실패한다', async () => {
    const notices = await thirdPartyNotices([{ name: 'ws', dir: 'node_modules/ws/' }], REPO_ROOT);

    expect(notices).toContain('## ws\n\nCopyright (c)');
    expect(notices).toContain('Permission is hereby granted, free of charge');
    await expect(thirdPartyNotices([{ name: 'docbridge', dir: 'scripts/' }], REPO_ROOT)).rejects.toThrow(
      '라이선스 파일이 없습니다: docbridge (scripts/)',
    );
  });

  it('패키지에 라이선스 파일이 없으면 scripts/pack/licenses/ 의 보충 고지(사람이 확인해 넣은 것)를 쓴다', async () => {
    // @pdf-lib/fontkit 1.1.1 은 package.json 에 MIT 만 적고 LICENSE 파일이 없다(SPEC-008, #108)
    const notices = await thirdPartyNotices([{ name: '@pdf-lib/fontkit', dir: 'node_modules/@pdf-lib/fontkit/' }], REPO_ROOT);

    expect(notices).toContain('## @pdf-lib/fontkit\n\n');
    expect(notices).toContain('Permission is hereby granted, free of charge');
    expect(notices).toContain('Devon Govett');
  });

  it('패키지 안에 함께 묶이거나 옮겨 온 코드의 고지(licenses/<이름>.bundled.txt)가 있으면 그 패키지 라이선스 뒤에 붙인다', async () => {
    // #114: @pdf-lib/fontkit dist 는 rollup 으로 의존성을 안에 넣은 번들이라 esbuild metafile 에 그 패키지들이 안 보인다.
    // pdf-lib 은 pdf.js(Apache-2.0) 코드를, standard-fonts 는 Adobe AFM 글꼴 정보를 안에 갖고 있다
    const notices = await thirdPartyNotices(
      [
        { name: '@pdf-lib/fontkit', dir: 'node_modules/@pdf-lib/fontkit/' },
        { name: '@pdf-lib/standard-fonts', dir: 'node_modules/@pdf-lib/standard-fonts/' },
        { name: 'pdf-lib', dir: 'node_modules/pdf-lib/' },
      ],
      REPO_ROOT,
    );
    const section = (name: string) => notices.slice(notices.indexOf(`## ${name}\n`)).split(/\n## (?!#)/)[0] ?? '';

    const fontkit = section('@pdf-lib/fontkit');
    for (const bundled of ['### @pdf-lib/brotli', '### @pdf-lib/restructure', '### buffer', '### ieee754', '### iconv-lite', '### pako', '### deep-equal', '### base64-arraybuffer']) {
      expect(fontkit).toContain(bundled);
    }
    expect(fontkit).toContain('Copyright 2013 Google Inc.');
    expect(fontkit).toContain('Apache License');
    expect(fontkit).toContain('Copyright 2008 Fair Oaks Labs, Inc.');
    expect(section('pdf-lib')).toContain('Copyright (c) 2019 Andrew Dillon');
    expect(section('pdf-lib')).toContain('Mozilla Foundation');
    expect(section('@pdf-lib/standard-fonts')).toContain('Adobe Font Metrics (AFM) for PDF Core 14 Fonts');
  });

  it('함께 묶인 코드 고지는 확인한 판에만 맞다 — 설치된 패키지 판이 다르거나 판이 안 적혀 있으면 다시 확인하라고 실패한다', () => {
    expect(() => checkBundledVersion('@pdf-lib/fontkit', '확인한 판: @pdf-lib/fontkit@1.0.0\n', '1.1.1')).toThrow(
      '@pdf-lib/fontkit 의 함께 묶인 코드 고지는 1.0.0 판을 확인한 것입니다(설치된 판 1.1.1). scripts/pack/licenses/@pdf-lib__fontkit.bundled.txt 를 다시 확인하세요',
    );
    expect(() => checkBundledVersion('@pdf-lib/fontkit', '확인한 판 없음', '1.1.1')).toThrow('확인한 판: @pdf-lib/fontkit@');
    expect(() => checkBundledVersion('@pdf-lib/fontkit', '확인한 판: @pdf-lib/fontkit@1.1.1\n', '1.1.1')).not.toThrow();
  });
});
