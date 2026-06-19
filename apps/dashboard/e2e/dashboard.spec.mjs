import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

const baseURL = process.env.RF_DASHBOARD_URL || 'http://127.0.0.1:8080';

const completedSetup = {
  version: 1,
  step: 4,
  roomName: 'E2E tap room',
  widthMeters: 6,
  heightMeters: 5,
  subjectId: 'e2e-person',
  emptyRecordings: 2,
  completedRecordingNames: ['empty-1', 'empty-2'],
  zones: [
    {
      id: 'door',
      label: 'door',
      x: 0.25,
      y: 0.2,
      stationary: 1,
      moving: 1,
    },
    {
      id: 'back',
      label: 'back',
      x: 0.75,
      y: 0.8,
      stationary: 1,
      moving: 1,
    },
  ],
  validation: {},
  complete: false,
};

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
    .poll(async () => page.locator('.rf-region').count(), { timeout: 12_000 })
    .toBeGreaterThan(0);

  await expect(page.locator('.rf-room-footer')).toContainText('not verified people counts');
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

test('guides a prepared room through model training', async ({ page }) => {
  let trainingRequest = null;
  await page.addInitScript((setup) => {
    localStorage.setItem('rfsense-room-setup/v1', JSON.stringify(setup));
  }, completedSetup);
  await page.route('**/api/model/train', async (route) => {
    trainingRequest = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        loaded: true,
        target: 'position',
        classes: ['empty', 'door', 'back'],
        recordings: 6,
        windows: 120,
        path: 'models/e2e-position.json',
        trainedAt: new Date().toISOString(),
        error: null,
      }),
    });
  });

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#fleetStatus')).toContainText('4 / 4', { timeout: 10_000 });
  await page.locator('#roomSetupLaunch').click();

  await expect(page.locator('#roomSetup')).toBeVisible();
  await expect(page.locator('#roomSetupSteps button')).toHaveCount(6);
  await page.locator('#roomSetupSteps button[data-step="4"]').click();
  await expect(page.getByRole('button', { name: 'Train position model' })).toBeEnabled();
  await page.getByRole('button', { name: 'Train position model' }).click();

  await expect.poll(() => trainingRequest).not.toBeNull();
  expect(trainingRequest).toMatchObject({
    target: 'position',
    window: 64,
    step: 32,
    minRecordingsPerClass: 2,
    roomGeometry: {
      format: 'rfsense-room-geometry/1',
      room: { name: 'E2E tap room', widthMeters: 6, heightMeters: 5 },
      zones: {
        door: { x: 1.5, y: 1 },
        back: { x: 4.5, y: 4 },
      },
    },
  });
  expect(trainingRequest.roomGeometry.receivers).toHaveLength(4);
  expect(trainingRequest.roomGeometry.receivers.map((receiver) => receiver.slot)).toEqual([
    'A',
    'B',
    'C',
    'D',
  ]);

  await expect(page.locator('#roomSetupSubtitle')).toContainText('Prove the live model');
  await expect(page.locator('.setup-validation')).toHaveCount(2);
  await expect(page.getByText('Model loaded with 3 classes')).toBeVisible();
});
