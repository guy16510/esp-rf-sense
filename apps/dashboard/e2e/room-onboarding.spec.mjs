import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

const baseURL = process.env.RF_DASHBOARD_URL || 'http://127.0.0.1:8080';

test.beforeEach(async ({ page }) => {
  await page.route('https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js', async (route) => {
    const body = await readFile('node_modules/d3/dist/d3.min.js');
    await route.fulfill({ status: 200, contentType: 'text/javascript', body });
  });
});

test('guides a new room through receiver and baseline gates', async ({ page, request }) => {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#fleetStatus')).toContainText('4 / 4', { timeout: 10_000 });
  await page.locator('#roomSetupLaunch').click();

  const wizard = page.locator('#roomSetup');
  await expect(wizard).toBeVisible();
  await expect(wizard.locator('#roomSetupSteps button')).toHaveCount(5);
  await expect(wizard.locator('[data-step="0"]')).toHaveClass(/active/);
  await expect(wizard.locator('[data-step="3"]')).toBeDisabled();

  const roomName = wizard.locator('[data-field="roomName"]');
  await roomName.fill('Browser test room');
  await roomName.blur();
  await wizard.locator('.room-setup-close').click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#roomSetupLaunch').click();
  await expect(wizard.locator('[data-field="roomName"]')).toHaveValue('Browser test room');

  await wizard.getByRole('button', { name: 'Continue' }).click();
  await expect(wizard.locator('.setup-receiver.ready')).toHaveCount(4);
  await expect(wizard).toContainText('4 of 4 receivers ready');
  await wizard.getByRole('button', { name: 'Continue' }).click();

  const recordButton = wizard.getByRole('button', { name: 'Record empty room' });
  await expect(recordButton).toBeEnabled();
  await expect(wizard).toContainText('0 / 2');
  await recordButton.click();
  await expect(wizard.locator('.setup-recording')).toBeVisible();
  await expect
    .poll(async () => {
      const response = await request.get(`${baseURL}/api/recording`);
      return Number((await response.json()).frames || 0);
    })
    .toBeGreaterThan(0);

  const stop = await request.post(`${baseURL}/api/recording/stop`);
  expect(stop.ok()).toBe(true);
  await expect(wizard.locator('.setup-recording')).toHaveCount(0);
  await expect(wizard).toContainText('1 / 2');
  await expect(wizard.locator('[data-step="3"]')).toBeDisabled();
  await expect(wizard).toContainText('Collect two empty-room recordings');
});
