// .mcpb 의 manifest.json 만들기(SPEC-004). 버전은 package.json, 도구 목록은 실제 MCP 서버(src/server/mcp.ts)에 물어 채운다 — 손으로 두 군데 적지 않는다.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { startBridge } from '../../src/server/bridge.ts';
import { DocumentSessions } from '../../src/server/documents.ts';
import { createMcpServer } from '../../src/server/mcp.ts';

export interface ToolSummary {
  name: string;
  description: string;
}

/** Claude Desktop 에 든 Node(Electron 44.9.3 = Node 24.22.0, 기술 검증 2026-10-28)에 맞춘 범위. 번들 target 은 node24 */
export const NODE_RUNTIME = '>=24.0.0';

/** 레포 맨 위 폴더(끝에 /) */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** npm run pack 이 만드는 파일 이름 */
export function mcpbFileName(version: string): string {
  return `docbridge-${version}.mcpb`;
}

/** npm run pack 이 만드는 파일 */
export function mcpbPath(version: string): string {
  return `${REPO_ROOT}dist/${mcpbFileName(version)}`;
}

const mcpbPackageDir = `${REPO_ROOT}node_modules/@anthropic-ai/mcpb/`;
const mcpbBin = z.object({ bin: z.string() }).parse(JSON.parse(readFileSync(`${mcpbPackageDir}package.json`, 'utf8'))).bin;

/**
 * mcpb CLI 실행 명령. node_modules/.bin/mcpb 는 윈도우에서 .cmd 라 execFile 로 바로 못 부르므로
 * 지금 Node 로 CLI 의 JS 진입 파일을 실행한다(PR #97 리뷰)
 */
export function mcpbCommand(args: string[]): { command: string; args: string[] } {
  return { command: process.execPath, args: [`${mcpbPackageDir}${mcpbBin}`, ...args] };
}

const packageJsonSchema = z.object({ version: z.string() });
const packageJsonPath = `${REPO_ROOT}package.json`;

export async function packageVersion(): Promise<string> {
  return packageJsonSchema.parse(JSON.parse(await readFile(packageJsonPath, 'utf8'))).version;
}

/** MCP 서버를 메모리 연결로 띄워 등록된 도구 전부의 이름과 설명을 받는다(뷰어 서버는 빈 포트로 잠깐 띄웠다 닫는다) */
export async function registeredTools(): Promise<ToolSummary[]> {
  const bridge = await startBridge({ port: 0, viewerDir: tmpdir() });
  const client = new Client({ name: 'docbridge-manifest', version: '0.0.0' });
  try {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(new DocumentSessions(bridge, { openBrowser: () => {} })).connect(serverSide);
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    return tools.map(({ name, description }) => ({ name, description: description ?? '' }));
  } finally {
    await client.close();
    await bridge.close();
  }
}

/**
 * 설치 화면에 보일 한 줄 설명: 도구 설명의 첫 문장(마침표 앞, 괄호 안 마침표는 무시).
 * 마침표가 없으면 설명 전체
 */
export function oneLine(description: string): string {
  let depth = 0;
  for (let i = 0; i < description.length; i += 1) {
    const char = description[i];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === '.' && depth === 0 && (i + 1 === description.length || description[i + 1] === ' ')) {
      return description.slice(0, i + 1);
    }
  }
  return description;
}

export function buildManifest(version: string, tools: ToolSummary[]) {
  return {
    manifest_version: '0.3',
    name: 'docbridge',
    display_name: 'docbridge',
    version,
    description: '받은 한글(HWP/HWPX) 문서를 Claude 채팅에서 묻고 고칩니다. 문서는 브라우저에 띄워 보여 줍니다.',
    author: { name: 'crowwan', url: 'https://github.com/crowwan' },
    repository: { type: 'git', url: 'https://github.com/crowwan/docbridge' },
    homepage: 'https://github.com/crowwan/docbridge',
    license: 'MIT',
    server: {
      type: 'node',
      entry_point: 'server/index.js',
      mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] },
    },
    tools: tools.map(({ name, description }) => ({ name, description: oneLine(description) })),
    compatibility: {
      platforms: ['darwin', 'win32'],
      runtimes: { node: NODE_RUNTIME },
    },
  };
}
