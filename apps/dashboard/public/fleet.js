const params = new URLSearchParams(window.location.search);
const guide = params.get("guide");

if (guide === "device") {
  document.body.innerHTML = `
    <main>
      <section class="hero">
        <div class="label">RF-SENSE GUIDED DEVICE SETUP</div>
        <h1>Connect, redirect, update, and validate all four ESP32 nodes</h1>
        <p>Changing the dashboard server IP is a configuration update. Installing firmware is OTA. You do not need to flash firmware just because the server IP changed.</p>
        <p><a href="/">Open control center</a> · <a href="/fleet?guide=calibrate">Run fast bar calibration</a></p>
      </section>
      <section><h2>1. First boot and Wi-Fi provisioning</h2><ol><li>Power one ESP32 at a time.</li><li>Join its RF-Sense Wi-Fi network.</li><li>Open 192.168.4.1.</li><li>Enter Wi-Fi, collector IP, UDP port 5566, OTA manifest URL, and a unique node name.</li><li>Repeat for nodes A, B, C, and D.</li></ol></section>
      <section><h2>2. Change the collector server IP without reflashing</h2><p>The command saves the new target, reads it back, and only then reboots the device.</p><pre>npm --workspace @rf-sense/cli run configure -- \\
  --host rf-sense-a1b2.local \\
  --collector-host 192.168.1.25 \\
  --collector-port 5566</pre></section>
      <section><h2>3. Check and apply OTA firmware</h2><pre>npm --workspace @rf-sense/cli run ota -- check --host rf-sense-a1b2.local
npm --workspace @rf-sense/cli run ota -- apply --host rf-sense-a1b2.local</pre><p>The firmware uses dual OTA slots, manifest validation, SHA-256 verification, boot validation, and rollback.</p></section>
      <section><h2>4. Validate before training</h2><ul><li>Dashboard shows 4 / 4 ready.</li><li>Every node reports fresh frames and a non-zero CSI rate.</li><li>Collector targets match the dashboard server.</li><li>Firmware versions match across all four nodes.</li><li>Room dimensions and receiver placement are saved.</li><li>Empty-room, trained-location, and held-out validation recordings exist.</li></ul><p>Do not treat the coarse-zone fallback as validated continuous XY.</p></section>
    </main>`;
} else if (guide === "calibrate") {
  const steps = [
    { label: "empty", empty: true },
    { label: "near-left", x: 0.18, y: 0.30 },
    { label: "near-center", x: 0.50, y: 0.30 },
    { label: "near-right", x: 0.82, y: 0.30 },
    { label: "far-left", x: 0.18, y: 0.72 },
    { label: "far-center", x: 0.50, y: 0.72 },
    { label: "far-right", x: 0.82, y: 0.72 },
  ];
  let snapshot = null;
  let stepIndex = 0;
  let running = false;
  let waitingForStop = false;

  document.body.innerHTML = `
    <main>
      <section class="hero">
        <div class="label">FAST BAR CALIBRATION</div>
        <h1>Train the customer area in about two minutes</h1>
        <p>One empty baseline and six short captures cover a 3 × 2 grid. No tape measure or manual coordinates are required.</p>
        <p><a href="/">Open control center</a> · <a href="/fleet?guide=device">Device setup</a></p>
      </section>
      <section>
        <h2 id="calibrationTitle">Ready to begin</h2>
        <p id="calibrationHint">Clear the customer area, confirm all four receivers are online, then start.</p>
        <progress id="calibrationProgress" max="7" value="0" style="width:100%"></progress>
        <p><button id="calibrationAction" type="button">Start two-minute calibration</button></p>
        <p id="calibrationStatus">Waiting for four healthy receiver streams.</p>
      </section>
      <section>
        <h2>Grid layout</h2>
        <pre>BAR / TAPS
near-left     near-center     near-right
far-left      far-center      far-right</pre>
        <p>Face the taps and remain mostly still during each 15-second capture. The page advances automatically after each recording.</p>
      </section>
      <section><h2>Fastest path to better accuracy</h2><ol><li>Run this pass once during setup.</li><li>Walk through all six zones and verify the circle.</li><li>If two zones are confused, rerun only after moving receivers farther apart or changing their height.</li><li>For the largest improvement, run a second pass on another day with a different person.</li></ol></section>
    </main>`;

  const action = document.getElementById("calibrationAction");
  const title = document.getElementById("calibrationTitle");
  const hint = document.getElementById("calibrationHint");
  const status = document.getElementById("calibrationStatus");
  const progress = document.getElementById("calibrationProgress");

  action.addEventListener("click", async () => {
    if (!snapshot?.readiness?.readyForCapture) {
      status.textContent = "Blocked: all four receivers must be healthy before recording.";
      return;
    }
    if (waitingForStop) return;
    if (!running) {
      running = true;
      stepIndex = 0;
    }
    const step = steps[stepIndex];
    const day = new Date().toISOString().slice(0, 10);
    const metadata = step.empty
      ? { label: "empty", target: "position", recordingId: `quick-bar-empty-${Date.now()}`, day, movement: "empty" }
      : { label: `occupied-${step.label}`, target: "position", recordingId: `quick-bar-${step.label}-${Date.now()}`, subjectId: "bar-operator", day, movement: "stationary", position: { label: step.label, x: step.x, y: step.y } };
    action.disabled = true;
    waitingForStop = true;
    title.textContent = `Recording ${stepIndex + 1} of ${steps.length}: ${step.label}`;
    hint.textContent = step.empty ? "Keep the customer area empty." : `Stand at ${step.label}, face the taps, and remain mostly still.`;
    try {
      await postJson("/api/recording/start", { label: encodeMetadata(metadata), targetSeconds: 15, targetFrames: 300 });
    } catch (error) {
      waitingForStop = false;
      action.disabled = false;
      status.textContent = error.message;
    }
  });

  const events = new EventSource("/events");
  events.addEventListener("snapshot", (event) => {
    snapshot = JSON.parse(event.data);
    const ready = snapshot?.readiness?.readyForCapture;
    if (!running) status.textContent = ready ? "4 / 4 ready. Calibration can start." : (snapshot?.readiness?.reasons || []).join(" · ");
  });
  events.addEventListener("recording", async (event) => {
    const recording = JSON.parse(event.data);
    if (!running || !waitingForStop || recording.active) return;
    waitingForStop = false;
    stepIndex += 1;
    progress.value = stepIndex;
    if (stepIndex >= steps.length) {
      title.textContent = "Training quick bar model";
      hint.textContent = "Building the six-zone model from the new recordings.";
      try {
        const model = await postJson("/api/model/train", { target: "position", window: 48, step: 16, minRecordingsPerClass: 1 });
        title.textContent = "Calibration complete";
        hint.textContent = "Walk through the six zones and confirm the circle follows the correct area.";
        status.textContent = `Loaded ${model.classes?.length || 0} zones from ${model.recordings || 0} recordings and ${model.windows || 0} windows.`;
        action.textContent = "Run calibration again";
        running = false;
        stepIndex = 0;
      } catch (error) {
        status.textContent = `Training failed: ${error.message}`;
        action.textContent = "Retry training";
      }
      action.disabled = false;
      return;
    }
    const next = steps[stepIndex];
    title.textContent = `${stepIndex} of ${steps.length} captured`;
    hint.textContent = `Move to ${next.label}, face the taps, then capture the next zone.`;
    action.textContent = `Capture ${next.label}`;
    action.disabled = false;
  });

  fetch("/api/nodes", { cache: "no-store" }).then((response) => response.json()).then((value) => { snapshot = value; });
} else {
  const get = (id) => document.getElementById(id);
  const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  function render(state) {
    const readiness = state.readiness || {};
    get("ready").textContent = readiness.readyForCapture ? "Ready" : "Blocked";
    get("online").textContent = `${readiness.onlineNodeCount || 0} / ${readiness.requiredNodeCount || 4}`;
    get("state").textContent = state.fused?.state || "waiting";
    get("disagreement").textContent = `${Math.round(num(state.fused?.disagreement) * 100)}%`;
    get("reason").textContent = readiness.reasons?.length ? readiness.reasons.join(" · ") : "All required RF links are fresh, calibrated, and within quality thresholds.";
    get("nodes").innerHTML = (state.nodes || []).map((node, index) => `<article><div class="node-head"><div><div class="label">RF LINK</div><h2>Node ${index + 1}</h2></div><span class="pill ${node.ready ? "ready" : ""}">${node.ready ? "READY" : "BLOCKED"}</span></div><div class="stats"><div class="stat"><span>State</span><strong>${node.state}</strong></div><div class="stat"><span>Frames</span><strong>${num(node.frames)}</strong></div><div class="stat"><span>Rate</span><strong>${num(node.frameRateHz).toFixed(1)} Hz</strong></div><div class="stat"><span>Loss</span><strong>${num(node.lossPpm)} ppm</strong></div><div class="stat"><span>Age</span><strong>${node.ageSec == null ? "Never" : `${num(node.ageSec).toFixed(1)}s`}</strong></div><div class="stat"><span>CSI</span><strong>${num(node.csiLength)} B</strong></div></div><p>${node.readinessReasons?.join(" · ") || "Healthy"}</p></article>`).join("");
  }
  const events = new EventSource("/events");
  events.addEventListener("nodes", (event) => render(JSON.parse(event.data)));
  fetch("/api/nodes", { cache: "no-store" }).then((response) => response.json()).then(render);
}

function encodeMetadata(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `rfsense-meta:${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

async function postJson(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || response.statusText);
  return value;
}
