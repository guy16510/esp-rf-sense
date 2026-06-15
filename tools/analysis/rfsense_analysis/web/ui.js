import * as d3 from "/d3.js";

const get = (id) => document.getElementById(id);
const percent = (value) => `${Math.round(100 * Number(value || 0))}%`;

export function setStream(kind, text) {
  get("streamDot").className = kind;
  get("streamStatus").textContent = text;
}

export function showCapabilities(values = {}) {
  const labels = {
    sceneHypotheses: "Scene hypotheses",
    peopleCount: "Count model",
    pose: "Pose model",
    orientation: "Orientation model",
    coarseDirection: "Coarse direction",
    campaignMarkers: "Campaign markers",
    history: "Rolling history",
  };
  const root = get("capabilityList");
  root.replaceChildren();
  for (const [key, label] of Object.entries(labels)) {
    const chip = document.createElement("span");
    chip.className = `capability ${values[key] ? "on" : ""}`;
    chip.textContent = `${values[key] ? "✓" : "○"} ${label}`;
    root.append(chip);
  }
}

export function showState(state, meta) {
  const age = state.stats?.ageSec;
  const stale = Number.isFinite(age) && age > 3;
  setStream(!state.ready ? "" : stale ? "stale" : "live", !state.ready ? state.reason || "Waiting" : stale ? `Stale ${age.toFixed(1)}s` : "Live");
  const audience = state.scene?.audience || {};
  get("audienceValue").textContent = state.ready ? String(audience.estimate || 0) : "—";
  get("audienceRange").textContent = state.ready
    ? audience.min === audience.max ? `Estimated ${audience.min}, ${percent(audience.confidence)} confidence` : `Likely range ${audience.min}–${audience.max}`
    : "Waiting for signal";
  get("stateValue").textContent = state.state || "—";
  get("targetValue").textContent = state.target ? `Model target: ${state.target}` : "No model target";
  get("confidenceValue").textContent = state.ready ? percent(state.confidence) : "—";
  get("confidenceBar").firstElementChild.style.width = percent(state.confidence);
  get("motionValue").textContent = state.ready ? Number(state.motion || 0).toFixed(3) : "—";
  get("directionValue").textContent = state.scene?.directionKnown ? "Coarse zone transition" : "Direction unavailable";
  const loss = Number(state.lossPpm || 0);
  const rate = Number(state.frameRateHz || 0);
  const quality = Math.max(0, Math.min(100, 100 - Math.min(55, loss / 200) - (stale ? 40 : 0) - (rate <= 0 ? 30 : 0)));
  get("qualityValue").textContent = state.ready ? `${Math.round(quality)}%` : "—";
  get("qualityDetail").textContent = stale ? "Stream is stale" : `${rate.toFixed(1)} Hz, ${loss.toFixed(1)} ppm loss`;
  get("deviceValue").textContent = state.stats?.deviceId || "—";
  get("frameRateValue").textContent = `${rate.toFixed(1)} Hz`;
  get("lossValue").textContent = `${loss.toFixed(1)} ppm`;
  get("subcarrierValue").textContent = state.subcarrierCount || "—";
  get("streamAgeValue").textContent = Number.isFinite(age) ? `${age.toFixed(2)} sec` : "—";
  get("modeValue").textContent = state.mode || meta?.mode || "—";
  get("sceneCaveat").textContent = state.scene?.caveat || meta?.disclaimer || "RF-derived hypothesis";
  showScores(state.scores || {});
  showProfile(state.amplitudeProfile || []);
}

function showScores(values) {
  const root = get("scoreList");
  root.replaceChildren();
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No classifier scores in heuristic mode.";
    root.append(empty);
    return;
  }
  for (const [label, value] of entries) {
    const row = document.createElement("div");
    row.className = "score-row";
    const name = document.createElement("label");
    name.textContent = label;
    const track = document.createElement("span");
    track.className = "score-track";
    const bar = document.createElement("i");
    bar.style.width = percent(value);
    track.append(bar);
    const score = document.createElement("strong");
    score.textContent = percent(value);
    row.append(name, track, score);
    root.append(row);
  }
}

function showProfile(values) {
  const svg = d3.select("#profileChart");
  if (!values.length) {
    svg.selectAll("*").remove();
    return;
  }
  const width = 1000;
  const height = 180;
  const x = d3.scaleLinear().domain([0, values.length - 1]).range([36, width - 14]);
  const extent = d3.extent(values);
  const y = d3.scaleLinear().domain(extent[0] === extent[1] ? [extent[0] - 1, extent[1] + 1] : extent).nice().range([height - 22, 14]);
  const line = d3.line().x((_, index) => x(index)).y((value) => y(value)).curve(d3.curveMonotoneX);
  svg.selectAll("path.profile").data([values]).join("path").attr("class", "profile")
    .attr("fill", "none").attr("stroke", "#39d9ff").attr("stroke-width", 1.8).attr("d", line);
}
