// docbridge 예시 흐름 데모 영상을 자동으로 녹화한다(열기 → 묻고 근거 표시 → 항목 옮기기 → 글자 바꾸기 → 저장).
// 실제 docbridge 서버(dist/server/index.js)를 MCP SDK 클라이언트로 하위 프로세스로 띄우고, 서버가 내준 뷰어를
// 데모 화면(scripts/demo/demo.html: 왼쪽 채팅 + 오른쪽 뷰어 iframe)에 넣어 헤드리스 Chromium 으로 녹화한다.
// 채팅 문구 중 문서 내용(날짜·번호·블록 id·파일 이름)은 모두 실제 도구 결과에서 만든다. 대기 시간은 연출용이다(테스트가 아님).
// 실행: npm run demo   (= 빌드 후 node scripts/demo/record-demo.ts [출력 폴더], 기본 ~/Downloads/docbridge-demo)
// 결과: docbridge-demo.webm, ffmpeg 가 있으면 docbridge-demo.mp4(H.264), 정지 화면 PNG 4장. 레포에 넣지 않는다.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Page } from '@playwright/test';
import { z } from 'zod';

/** demo.html 이 window 에 붙이는 채팅 연출 API */
interface DemoChat {
  setViewer(url: string): void;
  user(text: string): Promise<void>;
  toolStart(call: string): void;
  toolDone(summary: string): void;
  assistant(text: string): Promise<void>;
}

declare global {
  interface Window {
    demo?: DemoChat;
  }
}

const VIEWPORT = { width: 1920, height: 1080 } as const;
// 사용자 Claude Desktop 의 docbridge(7790~)와 겹치지 않는 포트. 3000 은 쓰지 않는다
const DEMO_PORT = '7900';
const outDir = process.argv[2] ?? join(homedir(), 'Downloads', 'docbridge-demo');
const serverEntry = fileURLToPath(new URL('../../dist/server/index.js', import.meta.url));
const demoPage = pathToFileURL(fileURLToPath(new URL('./demo.html', import.meta.url))).href;
const fixture = fileURLToPath(new URL('../../fixtures/notice.hwpx', import.meta.url));
// 회신 기한을 바꿀 날짜. fixture 의 기한(2026. 11. 14.)과 달라야 바뀐 것이 보인다
const NEW_DEADLINE = { spoken: '11월 13일', text: '2026. 11. 13.(금)' } as const;

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  isError: z.boolean().optional(),
});
const openSchema = z.object({ fileName: z.string(), pageCount: z.number(), blockCount: z.number() });
const findSchema = z.object({ matchCount: z.number(), matches: z.array(z.object({ id: z.string(), start: z.number(), end: z.number() })) });
const readSchema = z.object({ blocks: z.array(z.object({ id: z.string(), text: z.string().optional() })) });
const outlineSchema = z.object({
  blockCount: z.number(),
  blocks: z.array(z.object({ id: z.string(), kind: z.string(), text: z.string(), number: z.string().optional() })),
});
const highlightSchema = z.object({ highlighted: z.number(), pages: z.array(z.number()) });
const changedSchema = z.array(z.object({ id: z.string(), number: z.string().optional(), text: z.string() }));
const moveSchema = z.object({ moved: z.array(z.string()), changed: changedSchema });
const replaceSchema = z.object({ changed: changedSchema });
const saveSchema = z.object({ path: z.string(), bytes: z.number(), verified: z.object({ blockCount: z.number() }) });

// 날짜 "2026. 11. 14.(금)" 꼴
const DATE_PATTERN = /\d{4}\. \d{1,2}\. \d{1,2}\.(?:\([^)]+\))?/u;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 서버가 stderr 에 남기는 "뷰어 주소: …" 줄에서 주소를 읽는다(tests/server.test.ts 와 같은 방법) */
function viewerUrlFromLog(stderr: Readable): Promise<string> {
  return new Promise((resolve) => {
    let output = '';
    const onData = (chunk: Buffer) => {
      output += String(chunk);
      const url = /뷰어 주소: (\S+)/u.exec(output)?.[1];
      if (url === undefined) return;
      stderr.off('data', onData);
      resolve(url);
    };
    stderr.on('data', onData);
  });
}

/** 문자열 안 part 의 유니코드 글자 위치(서버 도구의 start·end 단위). 없으면 오류 */
function charRange(text: string, part: string): { start: number; end: number } {
  const index = text.indexOf(part);
  if (index === -1) throw new Error(`"${part}" 가 "${text}" 에 없습니다`);
  const start = [...text.slice(0, index)].length;
  return { start, end: start + [...part].length };
}

/** 채팅 패널 연출 */
function chatPanel(page: Page) {
  return {
    user: (text: string) => page.evaluate((t) => window.demo?.user(t), text),
    assistant: (text: string) => page.evaluate((t) => window.demo?.assistant(t), text),
    toolStart: (call: string) => page.evaluate((c) => window.demo?.toolStart(c), call),
    toolDone: (summary: string) => page.evaluate((s) => window.demo?.toolDone(s), summary),
  };
}

/** 영상 길이·해상도를 읽는다(헤드리스 Chromium 으로 영상 메타데이터를 읽는다. ffprobe 가 없어도 되게) */
async function videoInfo(page: Page, path: string): Promise<{ seconds: number; width: number; height: number }> {
  await page.goto(pathToFileURL(path).href);
  return page.evaluate(
    () =>
      new Promise<{ seconds: number; width: number; height: number }>((resolve, reject) => {
        const video = document.querySelector('video');
        if (video === null) {
          reject(new Error('영상을 열지 못했습니다'));
          return;
        }
        const done = () => resolve({ seconds: video.duration, width: video.videoWidth, height: video.videoHeight });
        const onMeta = () => {
          // 녹화한 webm 은 길이가 비어(Infinity) 있어 끝으로 넘겨 길이를 채운다
          if (Number.isFinite(video.duration)) done();
          else {
            video.addEventListener('durationchange', () => Number.isFinite(video.duration) && done());
            video.currentTime = Number.MAX_SAFE_INTEGER;
          }
        };
        if (video.readyState >= 1) onMeta();
        else video.addEventListener('loadedmetadata', onMeta, { once: true });
      }),
  );
}

function hasFfmpeg(): boolean {
  try {
    execFileSync('which', ['ffmpeg'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (!existsSync(serverEntry)) throw new Error('dist/server/index.js 가 없습니다. npm run demo 로 빌드부터 하세요.');
  mkdirSync(outDir, { recursive: true });
  const videoDir = mkdtempSync(join(tmpdir(), 'docbridge-demo-video-'));
  // 원본 fixture 대신 임시 폴더의 "공문.hwpx" 를 연다. 저장(공문-수정.hwpx)도 이 폴더에 생긴다
  const docDir = mkdtempSync(join(tmpdir(), 'docbridge-demo-doc-'));
  const docPath = join(docDir, '공문.hwpx');
  copyFileSync(fixture, docPath);

  // PATH 를 빈 폴더로 바꿔 서버가 `open` 으로 사용자 기본 브라우저를 띄울 수 없게 한다.
  // 뷰어는 데모 화면 iframe 이 먼저 붙으므로 서버가 브라우저를 열 일도 없다(둘째 안전장치)
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...getDefaultEnvironment(), PATH: join(docDir, 'no-bin'), DOCBRIDGE_PORT: DEMO_PORT },
    stderr: 'pipe',
  });
  const stderr = transport.stderr;
  if (!(stderr instanceof PassThrough)) throw new Error('서버 stderr 를 읽을 수 없습니다');
  const viewerUrl = viewerUrlFromLog(stderr);
  const client = new Client({ name: 'docbridge-demo', version: '0.0.0' });
  await client.connect(transport);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, recordVideo: { dir: videoDir, size: VIEWPORT } });
  const page = await context.newPage();
  const panel = chatPanel(page);
  const log: string[] = [];

  /** 터미널에 남길 결과에서 임시 폴더 경로와 뷰어 토큰을 가린다 */
  const hidePrivate = (value: string) => value.replaceAll(docDir, '<임시 폴더>').replace(/token=[\w-]+/gu, 'token=<가림>');

  /** 도구를 실제로 부르고 결과 JSON 을 스키마로 읽는다. 채팅에는 접힌 호출 줄(shown = 화면에 보일 인자)과 짧은 결과 */
  async function tool<T>(name: string, args: Record<string, unknown>, shown: string, schema: z.ZodType<T>, summary: (result: T) => string): Promise<T> {
    await panel.toolStart(`${name}(${shown})`);
    const raw = toolResultSchema.parse(await client.callTool({ name, arguments: args }));
    const text = raw.content.find((part) => part.type === 'text')?.text ?? '';
    if (raw.isError === true) throw new Error(`${name} 실패: ${text}`);
    const result = schema.parse(JSON.parse(text));
    log.push(`${name}(${hidePrivate(JSON.stringify(args))}) → ${hidePrivate(text)}`);
    await pause(900);
    await panel.toolDone(summary(result));
    await pause(1000);
    return result;
  }

  const still = (name: string) => page.screenshot({ path: join(outDir, name), scale: 'css' });

  try {
    await page.goto(demoPage);
    await page.evaluate((url) => window.demo?.setViewer(url), await viewerUrl);
    // 뷰어가 서버에 붙을 때까지(상태 줄 "준비됨") 기다린 뒤 도구를 부른다 → open_document 가 브라우저를 열지 않는다
    await page.frameLocator('#viewer').getByRole('status').filter({ hasText: '준비됨' }).waitFor({ timeout: 30_000 });
    await pause(2500);

    // 1. 열기
    await panel.user(`${basename(docPath)} 열어줘`);
    await pause(500);
    const opened = await tool('open_document', { path: docPath }, `path: "${basename(docPath)}"`, openSchema, (r) => `${r.pageCount}쪽, 블록 ${r.blockCount}개`);
    await panel.assistant(`${opened.fileName} 을 열었습니다. ${opened.pageCount}쪽, 블록 ${opened.blockCount}개짜리 공문이에요.`);
    await pause(4000);
    await still('01-open.png');

    // 2. 묻고 근거 표시
    await panel.user('회신 기한이 언제야? 근거 표시해줘');
    await pause(500);
    const found = await tool('find_text', { query: '회신 기한' }, 'query: "회신 기한"', findSchema, (r) => `${r.matchCount}곳`);
    const hit = found.matches[0];
    if (hit === undefined) throw new Error('회신 기한을 찾지 못했습니다');
    const read = await tool('read_blocks', { ids: [hit.id] }, `ids: ["${hit.id}"]`, readSchema, (r) => `블록 ${r.blocks.length}개`);
    const deadlineText = read.blocks[0]?.text ?? '';
    const deadline = DATE_PATTERN.exec(deadlineText)?.[0];
    if (deadline === undefined) throw new Error(`회신 기한 날짜가 없습니다: ${deadlineText}`);
    const evidence = { id: hit.id, start: hit.start, end: charRange(deadlineText, deadline).end };
    await tool(
      'highlight',
      { targets: [evidence], note: '회신 기한' },
      `targets: [{ id: "${evidence.id}", start: ${evidence.start}, end: ${evidence.end} }], note: "회신 기한"`,
      highlightSchema,
      (r) => `${r.pages.join(', ')}쪽에 ${r.highlighted}곳`,
    );
    await panel.assistant(`회신 기한은 ${deadline}까지입니다. 본문 "회신 기한: …" 항목에 있고, 뷰어에 노랗게 표시해 두었어요.`);
    await pause(4000);
    await still('02-highlight.png');

    // 3. 번호 항목 옮기기(3번을 1번 위로)
    await panel.user('3번 항목을 1번 위로 올려줘');
    await pause(500);
    const outline = await tool('get_outline', {}, '', outlineSchema, (r) => `블록 ${r.blockCount}개`);
    const numbered = (number: string) => {
      const block = outline.blocks.find((b) => b.kind === 'paragraph' && b.number === number);
      if (block === undefined) throw new Error(`${number} 번호 문단이 없습니다`);
      return block;
    };
    const third = numbered('3.');
    const first = numbered('1.');
    const moved = await tool(
      'move_blocks',
      { ids: [third.id], before: first.id },
      `ids: ["${third.id}"], before: "${first.id}"`,
      moveSchema,
      (r) => `옮김 ${r.moved.join(', ')}, 번호 바뀐 문단 ${r.changed.length}개`,
    );
    // 자동 번호 "1." → "1"
    const plain = (number: string | undefined) => (number ?? '').replace(/\.$/u, '');
    const newNumber = plain(moved.changed.find((c) => c.id === third.id)?.number);
    const renumbered = moved.changed.filter((c) => c.id !== third.id && c.number !== undefined).map((c) => plain(c.number));
    await panel.assistant(
      `"${third.text.split(':')[0]}" 항목을 맨 위로 옮겼습니다. 이제 ${newNumber}번이고, 원래 1·2번 항목은 ${renumbered.join('·')}번이 됐어요. 바뀐 문단은 초록 테두리로 보입니다.`,
    );
    await pause(4000);
    await still('03-move.png');

    // 4. 글자 바꾸기
    await panel.user(`회신 기한을 ${NEW_DEADLINE.spoken}로 바꿔줘`);
    await pause(500);
    const dateFound = await tool('find_text', { query: deadline }, `query: "${deadline}"`, findSchema, (r) => `${r.matchCount}곳`);
    const dateHit = dateFound.matches[0];
    if (dateHit === undefined) throw new Error(`${deadline} 를 찾지 못했습니다`);
    const target = { id: dateHit.id, start: dateHit.start, end: dateHit.end };
    const replaced = await tool(
      'replace_text',
      { target, text: NEW_DEADLINE.text },
      `target: { id: "${target.id}", start: ${target.start}, end: ${target.end} }, text: "${NEW_DEADLINE.text}"`,
      replaceSchema,
      (r) => `바뀐 블록 ${r.changed.map((c) => c.id).join(', ')}`,
    );
    const newDeadline = DATE_PATTERN.exec(replaced.changed[0]?.text ?? '')?.[0] ?? NEW_DEADLINE.text;
    await panel.assistant(`회신 기한을 ${deadline} → ${newDeadline} 로 바꿨습니다. 바뀐 문단에 초록 테두리가 남아요.`);
    await pause(4000);

    // 5. 저장
    await panel.user('저장해줘');
    await pause(500);
    const saved = await tool('save_document', {}, '', saveSchema, (r) => `${basename(r.path)}, 블록 ${r.verified.blockCount}개 확인`);
    await panel.assistant(
      `원본 옆에 ${basename(saved.path)} 로 저장했습니다. 저장한 파일을 다시 열어 블록 ${saved.verified.blockCount}개의 글자가 같은지 확인했어요. 원본은 그대로입니다.`,
    );
    await pause(4000);
    await still('04-save.png');
  } finally {
    await context.close();
    await client.close();
  }

  // 녹화 파일을 출력 폴더로 옮기고 길이·해상도를 읽는다
  const video = page.video();
  if (video === null) throw new Error('녹화 파일이 없습니다');
  const webm = join(outDir, 'docbridge-demo.webm');
  renameSync(await video.path(), webm);
  const infoContext = await browser.newContext();
  const info = await videoInfo(await infoContext.newPage(), webm);
  await browser.close();
  rmSync(videoDir, { recursive: true, force: true });
  rmSync(docDir, { recursive: true, force: true });

  const outputs = [webm];
  if (hasFfmpeg()) {
    const mp4 = join(outDir, 'docbridge-demo.mp4');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
    outputs.push(mp4);
  } else {
    console.log('ffmpeg 가 없어 mp4 는 만들지 않았습니다(webm 만).');
  }

  console.log('도구 호출:');
  for (const line of log) console.log(`  ${line}`);
  console.log(`영상: ${info.seconds.toFixed(1)}초, ${info.width}×${info.height}`);
  for (const path of outputs) console.log(`  ${path} (${(statSync(path).size / 1024 / 1024).toFixed(1)}MB)`);
  console.log(`정지 화면: ${outDir}/01-open.png … 04-save.png`);
}

await main();
