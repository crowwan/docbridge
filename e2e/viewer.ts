// E2E 도우미: 뷰어 열기, 캔버스에서 글자 잉크 영역 구하기
import { expect, type Page } from '@playwright/test';
import type { RenderMetrics } from '../src/viewer/api.ts';

export const FIXTURES = ['notice.hwpx', 'notice.hwp', 'report.hwpx', 'application.hwpx', 'outline-demo.hwpx'] as const;

export async function openFixture(page: Page, name: string): Promise<RenderMetrics> {
  await page.goto(`/?fixture=${name}`);
  // 뷰어가 렌더링을 마치면 풀리는 Promise 를 기다린다(시간 대기 없음)
  const metrics = await page.evaluate(() => window.docbridge?.ready);
  if (metrics === undefined) throw new Error('뷰어 API 가 없습니다');
  return metrics;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 쪽 캔버스의 region(쪽 px) 안에서 글자 잉크(어두운 화소)가 차지하는 영역. 없으면 null */
export async function inkBounds(page: Page, pageIndex: number, region: Box): Promise<Box | null> {
  const canvas = page.getByTestId(`page-canvas-${pageIndex}`);
  await expect(canvas).toBeVisible();
  return canvas.evaluate((el, r) => {
    if (!(el instanceof HTMLCanvasElement)) throw new Error('캔버스가 아닙니다');
    const context = el.getContext('2d');
    if (!context) throw new Error('2d 컨텍스트가 없습니다');
    const ratio = el.width / el.getBoundingClientRect().width;
    const x0 = Math.max(0, Math.floor(r.left * ratio));
    const y0 = Math.max(0, Math.floor(r.top * ratio));
    const x1 = Math.min(el.width, Math.ceil(r.right * ratio));
    const y1 = Math.min(el.height, Math.ceil(r.bottom * ratio));
    const { data } = context.getImageData(x0, y0, x1 - x0, y1 - y0);
    const width = x1 - x0;
    const isInk = (x: number, y: number) => {
      const i = (y * width + x) * 4;
      return 0.299 * (data[i] ?? 255) + 0.587 * (data[i + 1] ?? 255) + 0.114 * (data[i + 2] ?? 255) <= 160;
    };
    let found: { left: number; top: number; right: number; bottom: number } | null = null;
    for (let y = 0; y < y1 - y0; y += 1) {
      // 가로로 거의 꽉 찬 줄은 글자가 아니라 표 테두리 선이다
      let rowInk = 0;
      for (let x = 0; x < width; x += 1) if (isInk(x, y)) rowInk += 1;
      if (rowInk >= width * 0.9) continue;
      for (let x = 0; x < width; x += 1) {
        if (!isInk(x, y)) continue;
        const px = (x0 + x) / ratio;
        const py = (y0 + y) / ratio;
        found = found
          ? { left: Math.min(found.left, px), top: Math.min(found.top, py), right: Math.max(found.right, px + 1 / ratio), bottom: Math.max(found.bottom, py + 1 / ratio) }
          : { left: px, top: py, right: px + 1 / ratio, bottom: py + 1 / ratio };
      }
    }
    return found;
  }, region);
}
