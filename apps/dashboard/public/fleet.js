const params = new URLSearchParams(window.location.search);
if (params.get("guide") === "device") {
  document.body.innerHTML = '<main id="app"></main>';
  const script = document.createElement("script");
  script.type = "module";
  script.src = "/device-onboarding.js";
  document.body.append(script);
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
