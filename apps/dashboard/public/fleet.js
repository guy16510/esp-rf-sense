const params = new URLSearchParams(window.location.search);
if (params.get("guide") === "device") {
  document.body.innerHTML = `
    <main>
      <section class="hero">
        <div class="label">RF-SENSE GUIDED DEVICE SETUP</div>
        <h1>Connect, redirect, update, and validate all four ESP32 nodes</h1>
        <p>Changing the dashboard server IP is a configuration update. Installing firmware is OTA. You do not need to flash firmware just because the server IP changed.</p>
        <p><a href="/">Open control center</a></p>
      </section>
      <section>
        <h2>1. First boot and Wi-Fi provisioning</h2>
        <ol><li>Power one ESP32 at a time.</li><li>Join its RF-Sense Wi-Fi network.</li><li>Open 192.168.4.1.</li><li>Enter Wi-Fi, collector IP, UDP port 5566, OTA manifest URL, and a unique node name.</li><li>Repeat for nodes A, B, C, and D.</li></ol>
      </section>
      <section>
        <h2>2. Change the collector server IP without reflashing</h2>
        <p>The command saves the new target, reads it back, and only then reboots the device.</p>
        <pre>npm --workspace @rf-sense/cli run configure -- \\
  --host rf-sense-a1b2.local \\
  --collector-host 192.168.1.25 \\
  --collector-port 5566</pre>
      </section>
      <section>
        <h2>3. Check and apply OTA firmware</h2>
        <pre>npm --workspace @rf-sense/cli run ota -- check --host rf-sense-a1b2.local
npm --workspace @rf-sense/cli run ota -- apply --host rf-sense-a1b2.local</pre>
        <p>The firmware uses dual OTA slots, manifest validation, SHA-256 verification, boot validation, and rollback.</p>
      </section>
      <section>
        <h2>4. Validate before training</h2>
        <ul><li>Dashboard shows 4 / 4 ready.</li><li>Every node reports fresh frames and a non-zero CSI rate.</li><li>Collector targets match the dashboard server.</li><li>Firmware versions match across all four nodes.</li><li>Room dimensions and receiver placement are saved.</li><li>Empty-room, trained-location, and held-out validation recordings exist.</li></ul>
        <p>Do not treat the coarse-zone fallback as validated continuous XY.</p>
      </section>
    </main>`;
} else {
  const get = (id) => document.getElementById(id);
  const num = (value) =>
    Number.isFinite(Number(value)) ? Number(value) : 0;

  function render(state) {
    const readiness = state.readiness || {};
    get("ready").textContent = readiness.readyForCapture ? "Ready" : "Blocked";
    get("online").textContent =
      `${readiness.onlineNodeCount || 0} / ${readiness.requiredNodeCount || 4}`;
    get("state").textContent = state.fused?.state || "waiting";
    get("disagreement").textContent =
      `${Math.round(num(state.fused?.disagreement) * 100)}%`;
    get("reason").textContent = readiness.reasons?.length
      ? readiness.reasons.join(" · ")
      : "All required RF links are fresh, calibrated, and within quality thresholds.";
    get("nodes").innerHTML = (state.nodes || [])
      .map(
        (node, index) =>
          `<article><div class="node-head"><div><div class="label">RF LINK</div><h2>Node ${index + 1}</h2></div><span class="pill ${node.ready ? "ready" : ""}">${node.ready ? "READY" : "BLOCKED"}</span></div><div class="stats"><div class="stat"><span>State</span><strong>${node.state}</strong></div><div class="stat"><span>Frames</span><strong>${num(node.frames)}</strong></div><div class="stat"><span>Rate</span><strong>${num(node.frameRateHz).toFixed(1)} Hz</strong></div><div class="stat"><span>Loss</span><strong>${num(node.lossPpm)} ppm</strong></div><div class="stat"><span>Age</span><strong>${node.ageSec == null ? "Never" : `${num(node.ageSec).toFixed(1)}s`}</strong></div><div class="stat"><span>CSI</span><strong>${num(node.csiLength)} B</strong></div></div><p>${node.readinessReasons?.join(" · ") || "Healthy"}</p></article>`,
      )
      .join("");
  }

  const events = new EventSource("/events");
  events.addEventListener("nodes", (event) => render(JSON.parse(event.data)));
  fetch("/api/nodes", { cache: "no-store" })
    .then((response) => response.json())
    .then(render);
}
