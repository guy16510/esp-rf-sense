import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

const baseURL = process.env.RF_DASHBOARD_URL || 'http://127.0.0.1:8080';

test.beforeEach(async ({ page }) => {
  await page.route('https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js', async (route) => {
    const body = await readFile('node_modules/d3/dist/d3.min.js');
    await route.fulfill({ status: 200, contentType: 'text/javascript', body });
  });
});

test('renders four live receivers and the D3 room view', async ({ page }) => {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#roomD3')).toBeVisible();
  await expect(page.locator('.rf-node')).toHaveCount(4);
  await expect(page.locator('.node-card')).toHaveCount(4);
  await expect(page.locator('#fleetStatus')).toContainText('4 / 4');
  await expect(page.locator('.node-card.ready, .node-card.active')).toHaveCount(4);
  await expect(page.locator('.rf-link.ready')).toHaveCount(4);

  await expect
    .poll(async () => page.locator('#fusedState').textContent(), { timeout: 12_000 })
    .toMatch(/Clear|Activity/);

  await expect
    .poll(
      async () => {
        const regions = await page.locator('.rf-region').count();
        const trainedLayer = await page.locator('#trainedPositionLayer').count();
        return regions + trainedLayer;
      },
      { timeout: 12_000 },
    )
    .toBeGreaterThan(0);

  await expect(page.locator('.rf-room-footer')).toContainText(/not verified people counts|Position unavailable|No marker is shown/);
  await page.screenshot({
    path: 'apps/dashboard/e2e/artifacts/control-center.png',
    fullPage: true,
  });
});

test('starts and stops a capture after all streams are ready', async ({ page, request }) => {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-recording-label="empty"]')).toBeEnabled({ timeout: 10_000 });

  const response = await request.post(`${baseURL}/api/recording/start`, {
    data: { label: 'empty', targetSeconds: 5, targetFrames: 1 },
  });
  expect(response.status()).toBe(201);

  await expect(page.locator('#recordingBadge')).toContainText('Recording');
  const stop = await request.post(`${baseURL}/api/recording/stop`);
  expect(stop.ok()).toBe(true);
});
