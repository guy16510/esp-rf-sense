const params = new URLSearchParams(window.location.search);
const guide = params.get("guide");

if (guide === "device") {
  document.body.innerHTML = `
    <main>
      <section class="hero"><div class="label">RF-SENSE GUIDED DEVICE SETUP</div><h1>Connect, redirect, update, and validate all four ESP32 nodes</h1><p>Changing the dashboard server IP is configuration. Installing firmware is OTA.</p><p><a href="/">Open control center</a> · <a href="/fleet?guide=calibrate">Run fast bar calibration</a></p></section>
      <section><h2>1. First boot and Wi-Fi provisioning</h2><ol><li>Power one ESP32 at a time.</li><li>Join its RF-Sense Wi-Fi network.</li><li>Open 192.168.4.1.</li><li>Enter Wi-Fi, collector IP, UDP port 5566, OTA manifest URL, and a unique node name.</li><li>Repeat for nodes A, B, C, and D.</li></ol></section>
      <section><h2>2. Change the collector server IP without reflashing</h2><pre>npm --workspace @rf-sense/cli run configure -- \\
  --host rf-sense-a1b2.local \\
  --collector-host 192.168.1.25 \\
  --collector-port 5566</pre></section>
      <section><h2>3. Check and apply OTA firmware</h2><pre>npm --workspace @rf-sense/cli run ota -- check --host rf-sense-a1b2.local
npm --workspace @rf-sense/cli run ota -- apply --host rf-sense-a1b2.local</pre></section>
      <section><h2>4. Validate before training</h2><ul><li>Dashboard shows 4 / 4 ready.</li><li>Every node reports fresh frames and non-zero CSI rate.</li><li>Collector targets and firmware versions match.</li><li>Receiver placement is scored before calibration.</li></ul></section>
    </main>`;
} else if (guide === "calibrate") {
  const baseSteps = [
    { label: "empty", empty: true },
    { label: "near-left", x: 0.18, y: 0.30 },
    { label: "near-center", x: 0.50, y: 0.30 },
    { label: "near-right", x: 0.82, y: 0.30 },
    { label: "far-left", x: 0.18, y: 0.72 },
    { label: "far-center", x: 0.50, y: 0.72 },
    { label: "far-right", x: 0.82, y: 0.72 },
  ];
  let activeSteps = [...baseSteps];
  let snapshot = null;
  let stepIndex = 0;
  let pass = 1;
  let running = false;
  let waitingForStop = false;
  let validationIndex = -1;
  const liveConfusions = [];

  document.body.innerHTML = `
    <main>
      <section class="hero"><div class="label">FAST BAR CALIBRATION</div><h1>Train the customer area in about two minutes</h1><p>One empty baseline and six short captures cover a 3 × 2 grid. A second independent pass provides the biggest accuracy gain.</p><p><a href="/">Open control center</a> · <a href="/fleet?guide=device">Device setup</a></p></section>
      <section>
        <div class="stats"><label>Person or pass ID<input id="calibrationSubject" value="bar-operator-1"></label><label>Pass<input id="calibrationPass" type="number" min="1" value="1"></label></div>
        <h2 id="calibrationTitle">Ready to begin</h2><p id="calibrationHint">Clear the customer area and confirm all four receivers are online.</p><progress id="calibrationProgress" max="7" value="0" style="width:100%"></progress><p><button id="calibrationAction" type="button">Start first pass</button> <button id="validationAction" type="button" hidden>Start live validation</button> <button id="recaptureAction" type="button" hidden>Recapture confused zones</button></p><p id="calibrationStatus">Waiting for four healthy receiver streams.</p>
      </section>
      <section><h2>Receiver placement score</h2><p>Enter approximate normalized positions, 0 is left/front and 1 is right/back. Defaults are the recommended corners.</p><div class="stats" id="placementFields">${["A","B","C","D"].map((slot,index)=>{const values=[[0.05,0.05],[0.95,0.05],[0.05,0.95],[0.95,0.95]][index];return `<label>${slot} X<input data-place="${slot}-x" type="number" min="0" max="1" step=".05" value="${values[0]}"></label><label>${slot} Y<input data-place="${slot}-y" type="number" min="0" max="1" step=".05" value="${values[1]}"></label>`;}).join("")}</div><p><button id="placementAction" type="button">Score placement</button> <strong id="placementResult">Not scored</strong></p></section>
      <section><h2>Grid layout</h2><pre>BAR / TAPS
near-left     near-center     near-right
far-left      far-center      far-right</pre><p>Face the taps and remain mostly still. Recording stops as soon as four receivers provide enough diverse clean frames, with 15 seconds / 300 frames as the cap.</p></section>
      <section><h2>Accuracy strategy</h2><ol><li>Run pass 1.</li><li>Run pass 2 with another person or on another day.</li><li>Complete the live validation walk.</li><li>Recapture only zones that were actually confused.</li></ol></section>
    </main>`;

  const action = document.getElementById("calibrationAction");
  const validationAction = document.getElementById("validationAction");
  const recaptureAction = document.getElementById("recaptureAction");
  const title = document.getElementById("calibrationTitle");
  const hint = document.getElementById("calibrationHint");
  const status = document.getElementById("calibrationStatus");
  const progress = document.getElementById("calibrationProgress");

  document.getElementById("placementAction").addEventListener("click", () => {
    const points = ["A","B","C","D"].map((slot) => ({ x: numberValue(`${slot}-x`), y: numberValue(`${slot}-y`) }));
    const scored = scorePlacement(points);
    const result = document.getElementById("placementResult");
    result.textContent = `${Math.round(scored.score * 100)}%: ${scored.reasons.length ? scored.reasons.join("; ") : "good spread"}`;
    result.dataset.pass = String(scored.pass);
  });

  action.addEventListener("click", () => void captureStep());
  validationAction.addEventListener("click", () => validateNextZone());
  recaptureAction.addEventListener("click", () => {
    const labels = [...new Set(liveConfusions.flatMap((item) => [item.expected, item.predicted]).filter((value) => value && value !== "unknown"))];
    activeSteps = baseSteps.filter((step) => labels.includes(step.label));
    if (activeSteps.length === 0) return;
    pass += 1;
    document.getElementById("calibrationPass").value = String(pass);
    beginPass(`Targeted pass ${pass}`);
  });

  async function captureStep() {
    if (!snapshot?.readiness?.readyForCapture) return setStatus("Blocked: all four receivers must be healthy before recording.");
    if (waitingForStop) return;
    if (!running) beginPass(`Pass ${pass}`);
    const step = activeSteps[stepIndex];
    if (!step) return;
    const subjectId = String(document.getElementById("calibrationSubject").value || `bar-operator-${pass}`).trim();
    const day = new Date().toISOString().slice(0, 10);
    const group = `quick-bar:pass-${pass}:subject-${subjectId}:day-${day}`;
    const metadata = step.empty
      ? { label: "empty", target: "position", recordingId: `${group}:empty:${Date.now()}`, day, movement: "empty" }
      : { label: `occupied-${step.label}`, target: "position", recordingId: `${group}:${step.label}:${Date.now()}`, subjectId, day, movement: "stationary", position: { label: step.label, x: step.x, y: step.y } };
    action.disabled = true;
    waitingForStop = true;
    title.textContent = `Recording ${stepIndex + 1} of ${activeSteps.length}: ${step.label}`;
    hint.textContent = step.empty ? "Keep the customer area empty." : `Stand at ${step.label}, face the taps, and remain mostly still.`;
    try {
      await postJson("/api/recording/start", { label: encodeMetadata(metadata), targetSeconds: 15, targetFrames: 300 });
    } catch (error) {
      waitingForStop = false;
      action.disabled = false;
      setStatus(error.message);
    }
  }

  function beginPass(label) {
    running = true;
    stepIndex = 0;
    progress.max = activeSteps.length;
    progress.value = 0;
    title.textContent = label;
    action.textContent = `Capture ${activeSteps[0].label}`;
    validationAction.hidden = true;
    recaptureAction.hidden = true;
  }

  async function trainPass() {
    title.textContent = "Training bar model";
    hint.textContent = "Grouping windows by independent recording, person, and day.";
    try {
      const model = await postJson("/api/model/train", { target: "position", window: 48, step: 16, minRecordingsPerClass: 1 });
      title.textContent = `Pass ${pass} complete`;
      status.textContent = `Loaded ${model.classes?.length || 0} zones from ${model.recordings || 0} recordings and ${model.windows || 0} windows.`;
      running = false;
      stepIndex = 0;
      activeSteps = [...baseSteps];
      if (pass === 1) {
        pass = 2;
        document.getElementById("calibrationPass").value = "2";
        action.textContent = "Run independent second pass";
        hint.textContent = "Use another person or another day. This creates leakage-safe validation groups.";
      } else {
        action.textContent = "Run another full pass";
        validationAction.hidden = false;
        hint.textContent = "Run the live validation walk. Only mistaken zones will be recommended for recapture.";
      }
    } catch (error) {
      setStatus(`Training failed: ${error.message}`);
      action.textContent = "Retry training";
    } finally {
      action.disabled = false;
    }
  }

  function validateNextZone() {
    validationIndex += 1;
    const zones = baseSteps.filter((step) => !step.empty);
    if (validationIndex >= zones.length) {
      validationIndex = -1;
      const count = liveConfusions.length;
      title.textContent = count ? `${count} validation mistakes found` : "Live validation passed";
      hint.textContent = count ? "Recapture only the confused zones." : "No targeted recapture is needed.";
      recaptureAction.hidden = count === 0;
      validationAction.textContent = "Run validation again";
      return;
    }
    const expected = zones[validationIndex].label;
    if (validationIndex > 0) {
      const prior = zones[validationIndex - 1].label;
      const predicted = snapshot?.fused?.position?.accepted ? snapshot.fused.position.zone : "unknown";
      if (predicted !== prior) liveConfusions.push({ expected: prior, predicted });
    }
    title.textContent = `Validate ${expected}`;
    hint.textContent = `Stand at ${expected}. Wait for the circle to settle, then press Confirm.`;
    validationAction.textContent = validationIndex === zones.length - 1 ? "Confirm final zone" : "Confirm and continue";
  }

  const events = new EventSource("/events");
  events.addEventListener("snapshot", (event) => {
    snapshot = JSON.parse(event.data);
    if (!running && validationIndex < 0) setStatus(snapshot?.readiness?.readyForCapture ? "4 / 4 ready." : (snapshot?.readiness?.reasons || []).join(" · "));
  });
  events.addEventListener("recording", (event) => {
    const recording = JSON.parse(event.data);
    if (recording.active) {
      setStatus(`Quality ${Math.round(Number(recording.qualityScore || 0) * 100)}%, ${recording.receiverCount || 0}/4 receivers, ${recording.uniqueBuckets || 0} diverse buckets.`);
      return;
    }
    if (!running || !waitingForStop) return;
    waitingForStop = false;
    stepIndex += 1;
    progress.value = stepIndex;
    if (stepIndex >= activeSteps.length) return void trainPass();
    const next = activeSteps[stepIndex];
    title.textContent = `${stepIndex} of ${activeSteps.length} captured`;
    hint.textContent = `Move to ${next.label}, face the taps, then capture.`;
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

function numberValue(key) {
  return Number(document.querySelector(`[data-place="${key}"]`)?.value || 0);
}

function scorePlacement(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const xCoverage = Math.max(...xs) - Math.min(...xs);
  const yCoverage = Math.max(...ys) - Math.min(...ys);
  let minimum = Infinity;
  for (let left = 0; left < points.length; left += 1) for (let right = left + 1; right < points.length; right += 1) minimum = Math.min(minimum, Math.hypot(points[left].x - points[right].x, points[left].y - points[right].y));
  const area = xCoverage * yCoverage;
  const score = Math.max(0, Math.min(1, Math.min(1, xCoverage / .7) * .35 + Math.min(1, yCoverage / .7) * .35 + Math.min(1, minimum / .25) * .2 + Math.min(1, area / .35) * .1));
  const reasons = [];
  if (xCoverage < .5) reasons.push("insufficient width spread");
  if (yCoverage < .5) reasons.push("insufficient depth spread");
  if (minimum < .15) reasons.push("receivers too close");
  if (area < .12) reasons.push("placement too collinear");
  return { pass: reasons.length === 0 && score >= .65, score, reasons };
}

function setStatus(message) {
  const element = document.getElementById("calibrationStatus");
  if (element) element.textContent = message;
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
