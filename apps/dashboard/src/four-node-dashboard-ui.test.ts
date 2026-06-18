import { afterEach, describe, expect, it } from 'vitest';

import { MultiNodeEngine } from './multi-node-engine.js';
import { MultiNodeDashboardServer } from './multi-node-web-server.js';

const servers: MultiNodeDashboardServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

describe('four-node dashboard UI', () => {
  it('serves the dedicated per-node control center and its assets', async () => {
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
    expect(page).not.toContain('ESP32-S3 telemetry');

    const cssResponse = await fetch(`http://127.0.0.1:${port}/four-node-dashboard.css`);
    expect(cssResponse.status).toBe(200);
    expect(await cssResponse.text()).toContain('.node-grid');

    const scriptResponse = await fetch(`http://127.0.0.1:${port}/four-node-dashboard.js`);
    const script = await scriptResponse.text();
    expect(scriptResponse.status).toBe(200);
    expect(script).toContain('/api/nodes');
    expect(script).toContain("new EventSource('/events')");
    expect(script).toContain('allocateSlots');
  });
});
