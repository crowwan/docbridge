// SPEC-003 스타일 도구(#37): 서버가 내준 빌드된 뷰어에서 set_style · insert_paragraph style 이 화면을 다시 그리고
// 고른 문단과 개요 번호가 바뀐 문단에 바뀐 블록 표시를 남기는지 본다. npm run e2e 가 먼저 빌드한다.
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { insertParagraph, undo } from '../src/server/edit-tools.ts';
import { getOutline } from '../src/server/read-tools.ts';
import { DocumentSessions } from '../src/server/documents.ts';
import { setStyle } from '../src/server/style-tools.ts';

const viewerDir = fileURLToPath(new URL('../dist/viewer/', import.meta.url));
const fixturePath = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const SCREENS = 'test-results/screens';

let bridge: Bridge;
let sessions: DocumentSessions;

test.beforeEach(async ({ page }) => {
  bridge = await startBridge({ port: 0, viewerDir });
  sessions = new DocumentSessions(bridge, { openBrowser: (url) => void page.goto(url) });
});

test.afterEach(async () => {
  await bridge.close();
});

// 바뀐 블록 표시는 캔버스 위 장식이라 역할·글자가 없다 → 클래스로 찾는다(PLAYBOOK 4장 예외)
const marks = (page: Page) => page.locator('.edit-mark');

/** id → 자동 번호(없으면 undefined) */
async function numbers(): Promise<Map<string, string | undefined>> {
  return new Map((await getOutline(sessions.get())).blocks.map((block) => [block.id, block.number]));
}

test.describe('SPEC-003 스타일 바꾸기와 바뀐 블록 표시 (서버가 내주는 뷰어)', () => {
  test('AC-5 set_style 뒤 고른 문단이 개요 번호를 받고, 뒤 개요 번호가 다시 매겨진 문단까지 초록 테두리가 남는다. undo 하면 돌아온다', async ({ page }) => {
    await sessions.open(fixturePath('report.hwpx'));
    const firstPage = page.getByRole('region', { name: '1쪽' });
    await firstPage.screenshot({ path: `${SCREENS}/style-01-before.png` });

    // "가." 아래 본문 문단 b4 → 개요 1: "2." 가 되고 뒤 개요 1 문단들이 한 칸씩 밀린다
    const result = await setStyle(sessions.get(), ['b4'], '개요 1');

    const after = await numbers();
    expect([after.get('b2'), after.get('b4'), after.get('b7')]).toEqual(['1.', '2.', '3.']);
    expect(result.changed.map(({ id }) => id)).toEqual(expect.arrayContaining(['b4', 'b7']));
    await expect(marks(page)).toHaveCount(result.changed.length);
    await firstPage.screenshot({ path: `${SCREENS}/style-02-after-set-style.png` });

    expect(await undo(sessions.get(), 1)).toEqual({ undone: 1, edits: ['set_style b4 → 개요 1'] });
    await expect(marks(page)).toHaveCount(0);
    expect((await numbers()).get('b7')).toBe('2.');
  });

  test('AC-4 insert_paragraph 에 style 을 주면 가운데 정렬 제목 뒤에도 개요 번호 문단으로 그려진다', async ({ page }) => {
    await sessions.open(fixturePath('report.hwpx'));
    const firstPage = page.getByRole('region', { name: '1쪽' });

    const { inserted } = await insertParagraph(sessions.get(), { after: 'b1', text: '요약', style: '개요 1' });

    const after = await numbers();
    expect([after.get(inserted), after.get('b2')]).toEqual(['1.', '2.']);
    await expect(marks(page).first()).toBeVisible();
    await firstPage.screenshot({ path: `${SCREENS}/style-03-insert-with-style.png` });
  });
});
