// export_pdf(SPEC-008, #108)를 서버가 내준 실제 브라우저 뷰어로 확인한다: 쪽 SVG 에 화면 표시(하이라이트·note·바뀐 블록)가 없는지,
// 뷰어가 Canvas 로 잰 화면 글꼴 이름이 오는지, 이 컴퓨터의 시스템 글꼴로 만든 PDF 에서 글자가 뽑히는지. npm run e2e 가 먼저 빌드한다.
import { copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { DocumentSessions } from '../src/server/documents.ts';
import { replaceText } from '../src/server/edit-tools.ts';
import { exportPdf, systemFonts, unsavedEditsWarning } from '../src/server/export-pdf-tool.ts';
import { highlight } from '../src/server/highlight-tools.ts';
import { compact, inspectPdf } from '../scripts/pdf-check/inspect.ts';

const viewerDir = fileURLToPath(new URL('../dist/viewer/', import.meta.url));
const fixturePath = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const NOTE = 'PDF 에 들어가면 안 되는 메모';

let bridge: Bridge;
let sessions: DocumentSessions;
let dir: string;

test.beforeEach(async ({ page }) => {
  bridge = await startBridge({ port: 0, viewerDir });
  sessions = new DocumentSessions(bridge, { openBrowser: (url) => void page.goto(url) });
  dir = await mkdtemp(join(tmpdir(), 'docbridge-e2e-pdf-'));
  const source = join(dir, '공문.hwpx');
  await copyFile(fixturePath('notice.hwpx'), source);
  await sessions.open(source);
});

test.afterEach(async () => {
  await bridge.close();
});

test.describe('SPEC-008 PDF 로 내보내기 (서버가 내주는 뷰어)', () => {
  test('하이라이트·note·바뀐 블록 표시가 화면에 있어도 쪽 SVG·PDF 에는 문서 내용만 들어간다', async ({ page }) => {
    // AC-3
    // notice.hwpx b11 = "회신 기한: 2026. 11. 14.(금)까지 …"
    await replaceText(sessions.get(), { id: 'b11', start: 13, end: 20 }, '11. 7.');
    await expect(page.getByTestId('edit-mark-0')).toBeVisible();
    const marked = await sessions.get().requestViewer('export_pdf_pages', { pages: [0] });
    // 편집 표시(초록)와 하이라이트는 함께 있지 않다(편집하면 하이라이트를 지우고, 하이라이트하면 편집 표시를 지운다) — 차례로 본다
    await highlight(sessions.get(), [{ id: 'b1' }], NOTE);
    await expect(page.getByTestId('highlight-note')).toHaveText(NOTE);
    const highlighted = await sessions.get().requestViewer('export_pdf_pages', { pages: [0] });
    // 화면 표시는 DOM 오버레이라 쪽 SVG 는 같은 문서면 같다
    expect(highlighted.pages[0]?.svg).toBe(marked.pages[0]?.svg);
    expect(highlighted.pages[0]?.svg).not.toContain('메모');

    const result = await exportPdf(sessions.get(), {}, { fonts: systemFonts });
    const text = compact((await inspectPdf(new Uint8Array(await readFile(result.path)))).pages.map((p) => p.text).join(''));
    expect(result).toMatchObject({ path: join(dir, '공문.pdf'), pageCount: 1 });
    expect(result.warnings).toEqual([unsavedEditsWarning(1)]);
    expect(text).toContain(compact('2026. 11. 7.(금)까지'));
    expect(text).not.toContain(compact(NOTE));
    // 화면 표시는 그대로다(내보내기는 편집이 아니다)
    await expect(page.getByTestId('highlight-note')).toHaveText(NOTE);
    expect(sessions.get().unsavedEdits).toBe(1);
  });

  test('뷰어는 SVG 글꼴 차례마다 브라우저가 실제로 쓰는 글꼴 이름을 Canvas 로 재서 보낸다', async () => {
    const { pages, screenFonts } = await sessions.get().requestViewer('export_pdf_pages', { pages: [0] });

    expect(pages).toHaveLength(1);
    const entries = Object.entries(screenFonts);
    expect(entries.length).toBeGreaterThan(0);
    // 쓰는 이름은 그 차례 안의 이름이다(차례 맨 앞 문서 글꼴 "함초롬바탕" 은 이 컴퓨터에 없으면 건너뛴다)
    for (const [stack, used] of entries) expect(stack.split(',')).toContain(used);
    console.log(`화면 글꼴: ${JSON.stringify(screenFonts)}`);
  });
});
