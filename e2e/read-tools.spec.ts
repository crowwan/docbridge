// 서버(bridge + 문서 세션)가 내준 빌드된 뷰어에서 읽기 도구가 실제 rhwp(브라우저) 결과로 동작하는지 본다.
// 쪽 번호는 브라우저 조판 기준이다(Node 테스트와 다를 수 있다). npm run e2e 가 먼저 빌드한다.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { findText, getOutline, readBlockContents } from '../src/server/read-tools.ts';
import { DocumentSession } from '../src/server/session.ts';

const viewerDir = fileURLToPath(new URL('../dist/viewer/', import.meta.url));
const fixturePath = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

let bridge: Bridge;
let session: DocumentSession;

test.beforeEach(async ({ page }) => {
  bridge = await startBridge({ port: 0, viewerDir });
  session = new DocumentSession(bridge, { openBrowser: (url) => void page.goto(url) });
});

test.afterEach(async () => {
  await bridge.close();
});

test.describe('SPEC-001 문서 구조 읽기 도구 (서버가 내주는 뷰어)', () => {
  test('get_outline 은 본문 문단·표·누름틀을 문서 순서대로 id·kind·쪽·앞 40자와 함께 돌려주고, 자동 번호 문단은 번호 문자열을 포함한다', async () => {
    await session.open(fixturePath('notice.hwpx'));

    const outline = await getOutline(session);

    expect(outline.blockCount).toBe(14);
    expect(outline.blocks.map((b) => b.kind)).toEqual([
      'paragraph', 'paragraph', 'field', 'paragraph', 'paragraph',
      'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph',
      'table', 'paragraph', 'paragraph',
    ]);
    expect(outline.blocks.flatMap((b) => (b.number === undefined ? [] : [b.number]))).toEqual(['1.', '2.', '가.', '나.', '다.', '3.']);
    expect(outline.blocks.every((b) => b.page === 1)).toBe(true);
  });

  test('여러 쪽 문서에서 쪽 번호는 뷰어 조판 기준이고, 쪽 범위로 읽으면 그 쪽 블록만 온다', async () => {
    await session.open(fixturePath('report.hwpx'));

    const outline = await getOutline(session);
    const secondPage = await readBlockContents(session, { fromPage: 2, toPage: 2 });

    expect(Math.max(...outline.blocks.map((b) => b.page))).toBe(2);
    expect(secondPage.blocks.length).toBeGreaterThan(0);
    expect(secondPage.blocks.map((b) => b.id)).toEqual(outline.blocks.filter((b) => b.page === 2).map((b) => b.id));
  });

  test('read_blocks 는 표 블록에 대해 칸마다 행,열·텍스트·같은 행 첫 칸 텍스트를 돌려준다', async () => {
    await session.open(fixturePath('notice.hwpx'));
    const table = (await getOutline(session)).blocks.find((b) => b.kind === 'table');

    const result = await readBlockContents(session, { ids: [table?.id ?? ''] });

    const [block] = result.blocks;
    expect(block?.kind === 'table' ? block.cells : []).toContainEqual({ row: 2, col: 2, text: '구민회관 소강당', rowLabel: '2회차' });
  });

  test('find_text 는 일치하는 모든 위치의 블록 id·범위·앞뒤 20자를 돌려준다', async () => {
    await session.open(fixturePath('notice.hwpx'));
    const outline = await getOutline(session);

    const deadline = await findText(session, '회신 기한');
    const cell = await findText(session, '소강당');

    expect(deadline.matches).toHaveLength(1);
    const [match] = deadline.matches;
    expect(outline.blocks.find((b) => b.id === match?.id)?.number).toBe('3.');
    expect(match).toMatchObject({ start: 0, end: 5, before: '' });
    expect(cell.matches).toEqual([
      { id: outline.blocks.find((b) => b.kind === 'table')?.id, cell: { row: 2, col: 2 }, start: 5, end: 8, before: '구민회관 ', after: '' },
    ]);
  });
});
