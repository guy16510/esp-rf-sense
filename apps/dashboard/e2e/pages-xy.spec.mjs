import { test, expect } from '@playwright/test';

test('shows four receivers and accepted XY coordinates', async ({ page }) => {
  await page.goto(process.env.RF_PAGES_URL || 'http://127.0.0.1:4173');
  await expect(page.getByText('Four-receiver XY validation')).toBeVisible();
  await expect(page.locator('#coords')).toHaveText('X 2.50 m, Y 1.50 m');
  await expect(page.locator('#marker')).toBeVisible();
  await expect(page.locator('.receiver.ready')).toHaveCount(4);
  await expect(page.locator('#count')).toHaveText('4 / 4');
  await expect(page.locator('#uncertainty')).toHaveText('0.25 m');
});
