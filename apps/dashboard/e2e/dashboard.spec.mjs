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
  await expect.poll(async () => page.locator('#fusedState').textContent(), { timeout: 12_000 }).toMatch(/Clear|Activity/);
  await expect.poll(async () => {
    const regions = await page.locator('.rf-region').count();
    const trainedLayer = await page.locator('#trainedPositionLayer').count();
    return regions + trainedLayer;
  }, { timeout: 12_000 }).toBeGreaterThan(0);
  await expect(page.locator('.rf-room-footer')).toContainText(/not verified people counts|Position unavailable|No marker is shown|no receiver accepted a trained position/);
});

test('shows device redirection, OTA, and validation onboarding', async ({ page }) => {
  await page.goto(`${baseURL}/fleet?guide=device`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Connect, redirect, update/ })).toBeVisible();
  await expect(page.locator('pre').first()).toContainText('--collector-host');
  await expect(page.getByRole('heading', { name: /Check and apply OTA firmware/ })).toBeVisible();
});

test('starts grouped quick bar capture and scores receiver placement', async ({ page, request }) => {
  let requestBody = null;
  await page.route('**/api/recording/start', async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ active: true, targetSeconds: 15, targetFrames: 300 }),
    });
  });
  await page.goto(`${baseURL}/fleet?guide=calibrate`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#calibrationStatus')).toContainText('4 / 4 ready', { timeout: 10_000 });
  await page.locator('#placementAction').click();
  await expect(page.locator('#placementResult')).toContainText('good spread');
  await page.locator('#calibrationAction').click();
  await expect.poll(() => requestBody).not.toBeNull();
  expect(requestBody.targetSeconds).toBe(15);
  expect(requestBody.targetFrames).toBe(300);
  const metadata = decodeMetadata(requestBody.label);
  expect(metadata.target).toBe('position');
  expect(metadata.recordingId).toContain('quick-bar:pass-1:subject-bar-operator-1');
  const stop = await request.post(`${baseURL}/api/recording/stop`);
  expect(stop.ok()).toBe(true);
});

test('holds implausible fast coarse-zone jumps in the browser stream', async ({ page }) => {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(() => {
    const stream = window.RfSenseDashboardStream;
    const first = {
      fused: {
        modelTarget: 'coarse-zones',
        state: 'active',
        position: { accepted: true, zone: 'near-left', x: 0.18, y: 0.3, confidence: 0.7 },
        bubbles: [{ x: 0.18, y: 0.3, zone: 'near-left' }],
      },
    };
    const second = {
      fused: {
        modelTarget: 'coarse-zones',
        state: 'active',
        position: { accepted: true, zone: 'far-right', x: 0.82, y: 0.72, confidence: 0.7 },
        bubbles: [{ x: 0.82, y: 0.72, zone: 'far-right' }],
      },
    };
    stream.guardCoarseTransition(first);
    stream.guardCoarseTransition(second);
    return second.fused.position;
  });
  expect(result.zone).toBe('near-left');
  expect(result.reason).toContain('implausible jump');
});

test('falls back to uploaded coarse position recordings when continuous XY cannot train', async ({ page }) => {
  const targets = [];
  await page.route('**/api/model/train', async (route) => {
    const body = route.request().postDataJSON();
    targets.push(body.target);
    if (body.target === 'continuous-xy') {
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'no usable RFV2 continuous XY recordings' }) });
      return;
    }
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ loaded: true, target: 'coarse-zones', recordings: 9, windows: 180, classes: ['empty', 'left', 'center', 'right'] }) });
  });
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.locator('#trainModelButton').click();
  await expect(page.locator('#modelBadge')).toHaveText('Coarse XY fallback');
  expect(targets).toEqual(['continuous-xy', 'position']);
});

test('starts and stops a capture after all streams are ready', async ({ page, request }) => {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-recording-label="empty"]')).toBeEnabled({ timeout: 10_000 });
  const response = await request.post(`${baseURL}/api/recording/start`, { data: { label: 'empty', targetSeconds: 5, targetFrames: 1 } });
  expect(response.status()).toBe(201);
  const stop = await request.post(`${baseURL}/api/recording/stop`);
  expect(stop.ok()).toBe(true);
});

function decodeMetadata(label) {
  const encoded = label.slice('rfsense-meta:'.length).replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}
