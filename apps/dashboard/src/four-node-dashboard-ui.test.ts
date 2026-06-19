import { afterEach, describe, expect, it } from 'vitest';

import { MultiNodeEngine } from './multi-node-engine.js';
import { MultiNodeDashboardServer } from './multi-node-web-server.js';

const servers: MultiNodeDashboardServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

describe('four-node dashboard UI', () => {
  it('serves the per-node control center, D3 room assets, and guided room onboarding', async () => {
    const server = new MultiNodeDashboardServer(new MultiNodeEngine(), {
      host: '127.0.0.1',
      port: 0,
      intervalMs: 50,
    });
    servers.push(server);
    await server.start();

    const port = server.address()?.port;
    expect(port).toBeTypeOf('number');

    const pageResponse = await fetch(`http://127.0.0.1:${port}/`);
    const page = await pageResponse.text();
    expect(pageResponse.status).toBe(200);
    expect(pageResponse.headers.get('content-type')).toContain('text/html');
    expect(page).toContain('Four-node RF control center');
    expect(page).toContain('id="nodeGrid"');
    expect(page).toContain('id="nodeCardTemplate"');
    expect(page).toContain('id="roomSetupLaunch"');
    expect(page).toContain('id="roomSetup"');
    expect(page).toContain('GUIDED SETUP');
    expect(page).toContain('Set up room');
    expect(page).toContain('Record empty room');
    expect(page).toContain('Record one stationary and one moving session');
    expect(page).toContain("format:'rfsense-room-geometry/1'");
    expect(page).toContain('REQUIRED_MATCHES');
    expect(page).toContain("request('/api/model/train'");
    expect(page).not.toContain('ESP32-S3 telemetry');

    const cssResponse = await fetch(`http://127.0.0.1:${port}/four-node-dashboard.css`);
    expect(cssResponse.status).toBe(200);
    expect(await cssResponse.text()).toContain('.node-grid');

    const scriptResponse = await fetch(`http://127.0.0.1:${port}/four-node-dashboard.js`);
    const script = await scriptResponse.text();
    expect(scriptResponse.status).toBe(200);
    expect(script).toContain("import './dashboard-stream.js'");
    expect(script).toContain("import './four-node-dashboard-core.js'");
    expect(script).toContain("import './room-d3.js'");

    const streamResponse = await fetch(`http://127.0.0.1:${port}/dashboard-stream.js`);
    const stream = await streamResponse.text();
    expect(streamResponse.status).toBe(200);
    expect(stream.match(/new EventSource\('\/events'\)/gu)).toHaveLength(1);
    expect(stream).toContain("source.addEventListener('snapshot'");

    const coreResponse = await fetch(`http://127.0.0.1:${port}/four-node-dashboard-core.js`);
    const core = await coreResponse.text();
    expect(coreResponse.status).toBe(200);
    expect(core).toContain('/api/nodes');
    expect(core).toContain('allocateSlots');
    expect(core).toContain('ensureNodeCards');

    const roomResponse = await fetch(`http://127.0.0.1:${port}/room-d3.js`);
    const room = await roomResponse.text();
    expect(roomResponse.status).toBe(200);
    expect(room).toContain('d3.select');
    expect(room).toContain("dashboardStream?.on('snapshot'");
    expect(room).toContain('estimateRegion');
    expect(room).toContain('not verified people counts');

    const roomCssResponse = await fetch(`http://127.0.0.1:${port}/room-d3.css`);
    expect(roomCssResponse.status).toBe(200);
    expect(await roomCssResponse.text()).toContain('.rf-workspace');
  });
});
