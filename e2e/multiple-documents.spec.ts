// 여러 문서(SPEC-007): 서버가 내준 빌드된 뷰어로 문서마다 탭을 띄우고, 탭 제목·doc 이름·● 표시·탭 닫기 알림·close_document·copy_blocks(문서 사이 복사)를 본다.
// 브라우저 여는 함수는 Playwright 새 페이지(탭)로 바꿔 넣는다. 도구는 MCP 클라이언트로 불러 결과 알림까지 본다.
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { z } from 'zod';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { DocumentSessions } from '../src/server/documents.ts';
import { createMcpServer } from '../src/server/mcp.ts';

const viewerDir = fileURLToPath(new URL('../dist/viewer/', import.meta.url));
const fixturePath = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const SCREENS = 'test-results/screens';

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});

let bridge: Bridge;
let sessions: DocumentSessions;
let client: Client;
/** 문서 이름 → 그 문서 탭(페이지) */
let tabs: Map<string, Page>;

test.beforeEach(async ({ context }) => {
  bridge = await startBridge({ port: 0, viewerDir });
  tabs = new Map();
  sessions = new DocumentSessions(bridge, { openBrowser: (url) => void openTab(context, url), tabCloseGraceMs: 0 });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(sessions).connect(serverSide);
  client = new Client({ name: 'docbridge-e2e', version: '0.0.0' });
  await client.connect(clientSide);
});

test.afterEach(async () => {
  await client.close();
  await bridge.close();
});

/** 브라우저가 새 탭에 주소를 여는 것처럼 새 페이지를 띄운다 */
async function openTab(context: BrowserContext, url: string): Promise<void> {
  const page = await context.newPage();
  tabs.set(new URL(url).searchParams.get('doc') ?? '', page);
  await page.goto(url);
}

function tab(doc: string): Page {
  const page = tabs.get(doc);
  if (page === undefined) throw new Error(`${doc} 탭이 없다`);
  return page;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = toolResultSchema.parse(await client.callTool({ name, arguments: args }));
  if (result.isError) throw new Error(result.content[0]?.text);
  return { json: z.looseObject({}).parse(JSON.parse(result.content[0]?.text ?? '')), notices: result.content.slice(1).map(({ text }) => text) };
}

/** 탭을 보지 않는(hidden) 것으로 둔다. 헤드리스 브라우저의 탭은 늘 보이는 상태라 visibilityState 를 바꿔 흉내 낸다 */
async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test.describe('SPEC-007 여러 문서 탭 (서버가 내주는 뷰어)', () => {
  test('AC-1 두 파일을 열면 탭 두 개에 각각 뜨고, 탭 제목은 파일 이름·도구 막대에 doc 이름이 보인다', async () => {
    expect((await call('open_document', { path: fixturePath('notice.hwpx') })).json).toMatchObject({ doc: 'd1' });
    expect((await call('open_document', { path: fixturePath('report.hwpx') })).json).toMatchObject({ doc: 'd2' });

    await expect(tab('d1')).toHaveTitle('notice.hwpx');
    await expect(tab('d2')).toHaveTitle('report.hwpx');
    await expect(tab('d1').getByTestId('doc-name')).toHaveText('d1');
    await expect(tab('d2').getByTestId('doc-name')).toHaveText('d2');
    await expect(tab('d2').getByRole('status')).toHaveText('report.hwpx — 2쪽');
    expect(new URL(tab('d2').url()).searchParams.get('doc')).toBe('d2');
    await tab('d1').locator('.toolbar').screenshot({ path: `${SCREENS}/multi-01-toolbar-d1.png` });
    await tab('d2').locator('.toolbar').screenshot({ path: `${SCREENS}/multi-02-toolbar-d2.png` });

    // doc 으로 고른 문서 탭에만 그린다
    await call('highlight', { doc: 'd1', targets: [{ id: 'b11' }], note: 'd1 회신 기한' });
    await expect(tab('d1').getByTestId('highlight-note')).toHaveText('d1 회신 기한');
    await expect(tab('d2').getByTestId('highlight-note')).toHaveCount(0);
    await tab('d1').screenshot({ path: `${SCREENS}/multi-03-d1-highlight.png` });
  });

  test('보지 않는 탭에 하이라이트·편집이 생기면 탭 제목 앞에 ● 를 붙이고, 그 탭을 보면 지운다', async () => {
    await call('open_document', { path: fixturePath('notice.hwpx') });
    await call('open_document', { path: fixturePath('report.hwpx') });
    await setVisibility(tab('d1'), 'hidden');

    await call('replace_text', { doc: 'd1', target: { id: 'b1' }, text: '라마바구청' });

    await expect(tab('d1')).toHaveTitle('● notice.hwpx');
    // 보고 있는 탭은 붙이지 않는다
    await call('highlight', { doc: 'd2', targets: [{ id: 'b1' }] });
    await expect(tab('d2')).toHaveTitle('report.hwpx');

    await setVisibility(tab('d1'), 'visible');
    await expect(tab('d1')).toHaveTitle('notice.hwpx');
  });

  test('AC-8 사용자가 탭을 닫으면 그 문서가 빠지고 다음 도구 결과에 알린다', async () => {
    await call('open_document', { path: fixturePath('notice.hwpx') });
    await call('open_document', { path: fixturePath('report.hwpx') });
    await call('replace_text', { doc: 'd2', target: { id: 'b1' }, text: '고친 제목' });

    await tab('d2').close();
    await expect.poll(() => sessions.list().documents.map(({ doc }) => doc)).toEqual(['d1']);

    const { json, notices } = await call('get_outline');
    expect(json).toMatchObject({ doc: 'd1' });
    expect(notices).toEqual(['d2 탭이 닫혀 문서를 닫았습니다(저장하지 않은 편집 1개를 버렸습니다)']);
    expect((await call('get_outline')).notices).toEqual([]);
  });

  test('AC-4 close_document 로 닫은 탭은 "문서를 닫았습니다" 화면이 되고, 다음에 여는 문서가 그 탭을 쓴다', async ({ context }) => {
    await call('open_document', { path: fixturePath('notice.hwpx') });
    const d1 = tab('d1');

    expect((await call('close_document')).json).toEqual({ doc: 'd1', closed: true });

    await expect(d1.getByRole('heading', { name: '문서를 닫았습니다' })).toBeVisible();
    await expect(d1).toHaveTitle('docbridge 뷰어');
    await expect(d1.getByTestId('doc-name')).toBeHidden();
    await d1.screenshot({ path: `${SCREENS}/multi-04-closed.png` });

    expect((await call('open_document', { path: fixturePath('report.hwpx') })).json).toMatchObject({ doc: 'd2' });
    await expect(d1).toHaveTitle('report.hwpx');
    await expect(d1.getByTestId('doc-name')).toHaveText('d2');
    expect(context.pages()).toHaveLength(1);
  });

  test('AC-5 copy_blocks 로 d1 의 번호 문단·표를 d2 에 넣으면 d2 탭에 다시 그려지고 넣은 블록에 초록 표시, d1 탭은 그대로다. undo 한 번에 돌아간다', async () => {
    await call('open_document', { path: fixturePath('notice.hwpx') });
    await call('open_document', { path: fixturePath('report.hwpx') });
    const d2Page = tab('d2').getByRole('region', { name: '1쪽' });
    await d2Page.screenshot({ path: `${SCREENS}/copy-01-d2-before.png` });

    // 공문의 "3. 회신 기한" + 일정 표 → 보고서 제목(b1) 뒤
    const { json } = await call('copy_blocks', { from: 'd1', ids: ['b11', 'b12'], to: 'd2', after: 'b1' });

    expect(json).toMatchObject({ doc: 'd2', inserted: [expect.any(String), expect.any(String)] });
    // 바뀐 블록 표시는 캔버스 위 장식이라 역할·글자가 없다 → 클래스로 찾는다(PLAYBOOK 4장 예외)
    await expect(tab('d2').locator('.edit-mark').first()).toBeVisible();
    await expect(tab('d2').locator('.edit-mark').first()).toHaveCSS('outline-color', 'rgb(30, 166, 114)');
    await expect(tab('d1').locator('.edit-mark')).toHaveCount(0);
    await d2Page.screenshot({ path: `${SCREENS}/copy-02-d2-after-copy.png` });
    await tab('d1').getByRole('region', { name: '1쪽' }).screenshot({ path: `${SCREENS}/copy-03-d1-source.png` });

    expect((await call('undo', { doc: 'd2' })).json).toMatchObject({ doc: 'd2', undone: 1, edits: ['copy_blocks d1 b11, b12 → after b1'] });
    await expect(tab('d2').locator('.edit-mark')).toHaveCount(0);
  });
});
