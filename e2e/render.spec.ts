import { expect, test } from '@playwright/test';
import { FIXTURES, inkBounds, openFixture } from './viewer.ts';

test.describe('SPEC-001 렌더링 (기술 검증)', () => {
  for (const name of FIXTURES) {
    test(`${name} 의 모든 쪽을 그린다`, async ({ page }) => {
      const metrics = await openFixture(page, name);

      expect(metrics.pageCount).toBeGreaterThan(0);
      await expect(page.getByRole('status')).toHaveText(`${name} — ${metrics.pageCount}쪽`);
      await expect(page.getByRole('region', { name: /쪽$/ })).toHaveCount(metrics.pageCount);
      // 쪽마다 글자가 실제로 그려졌는지(빈 캔버스가 아닌지) 본다
      for (let i = 0; i < metrics.pageCount; i += 1) {
        const ink = await inkBounds(page, i, { left: 0, top: 0, right: 794, bottom: 1123 });
        expect(ink, `${i + 1}쪽에 글자가 없다`).not.toBeNull();
      }
      await page.getByRole('region', { name: '1쪽' }).screenshot({ path: `test-results/screens/render-${name}.png` });
    });
  }
});
