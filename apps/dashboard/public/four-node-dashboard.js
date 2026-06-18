const get = (id) => document.getElementById(id);
const template = get('nodeCardTemplate');
const slotAssignments = new Map();
const history = [];

let latestSnapshot = null;
let latestRecording = null;
let streamConnected = false;
let lastStreamEventAt = 0;

const number = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const finite = (value) => Number.isFinite(Number(value));
const percent = (value) => `${Math.round(Math.max(0, Math.min(1, number(value))) * 100)}%`;
const integer = (value) => number(value).toLocaleString();
async function json(url, options) {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || response.statusText);
  return value;
}

async function optionalJson(url) {
  try {
    return await json(url);
  } catch {
    return null;
  }
}

function labelState(state) {
  return (
    { waiting: 'Waiting', baseline: 'Learning', clear: 'Clear', active: 'Activity' }[state] ||
    String(state || 'Waiting')
  );
}

function stateDetail(state) {
  if (state === 'active') return 'One or more ready links detect meaningful RF disturbance.';
  if (state === 'clear') return 'Ready links agree that the RF paths are clear.';
  if (state === 'baseline') return 'At least one node is still learning its empty-room baseline.';
  return 'Waiting for enough healthy node streams to fuse.';
}

function classifyNode(node) {
  if (!node) return { level: 'missing', label: 'Missing' };
  const stale = node.ageSec === null || (finite(node.ageSec) && number(node.ageSec) > 3);
  if (stale) return { level: 'stale', label: 'Stale' };
  if (!node.ready) return { level: 'issue', label: 'Needs attention' };
  if (node.state === 'active') return { level: 'active', label: 'Activity' };
  return { level: 'ready', label: 'Ready' };
}

function allocateSlots(nodes, requiredCount) {
  const count = Math.max(4, requiredCount || 4);
  const slots = Array(count).fill(null);
  for (const node of nodes) {
    const id = String(node.deviceId || 'unknown');
    if (!slotAssignments.has(id)) {
      const used = new Set(slotAssignments.values());
      const free = Array.from({ length: count }, (_, index) => index).find(
        (index) => !used.has(index),
      );
      if (free !== undefined) slotAssignments.set(id, free);
    }
    const slot = slotAssignments.get(id);
    if (slot !== undefined && slot < count) slots[slot] = node;
  }
  return slots;
}

function renderSnapshot(snapshot) {
  latestSnapshot = snapshot;
  lastStreamEventAt = Date.now();
  const readiness = snapshot?.readiness || {};
  const fused = snapshot?.fused || {};
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const required = Math.max(4, number(readiness.requiredNodeCount, 4));
  const ready = number(readiness.onlineNodeCount, nodes.filter((node) => node.ready).length);

  get('fleetStatus').textContent = `${ready} / ${required} ready`;
  get('readyNodes').textContent = `${ready} / ${required}`;
  get('readinessDetail').textContent = readiness.readyForCapture
    ? 'Capture prerequisites satisfied'
    : (readiness.reasons || []).join('; ') || 'Waiting for healthy streams';

  const state = fused.state || 'waiting';
  const fusedCard = get('fusedStateCard');
  fusedCard.className = `fused-state-card ${state}`;
  get('fusedState').textContent = labelState(state);
  get('fusedDetail').textContent = stateDetail(state);
  get('fusedConfidence').textContent = percent(fused.confidence);
  get('fusedConfidenceBar').style.width = percent(fused.confidence);
  get('combinedRate').textContent = `${number(fused.frameRateHz).toFixed(1)} Hz`;
  get('combinedFrames').textContent = `${integer(fused.frames)} frames`;
  get('totalDatagrams').textContent = integer(fused.datagrams);
  get('invalidDatagrams').textContent = `${integer(fused.invalidDatagrams)} invalid`;
  get('disagreement').textContent = percent(fused.disagreement);
  get('contributors').textContent = `${(fused.contributingNodes || []).length} contributors`;
  get('subcarrierCount').textContent = `${(fused.amplitudeProfile || []).length} subcarriers`;

  renderNodeGrid(allocateSlots(nodes, required));
  drawProfile(get('fusedProfile'), fused.amplitudeProfile || [], true);
  renderReadiness(snapshot);
  updateRecordingControls();
}

function renderNodeGrid(slots) {
  const root = get('nodeGrid');
  root.replaceChildren();
  slots.slice(0, 4).forEach((node, index) => {
    const fragment = template.content.cloneNode(true);
    const card = fragment.querySelector('.node-card');
    const status = classifyNode(node);
    card.className = `node-card ${status.level}`;
    fragment.querySelector('.node-slot').textContent =
      `Receiver ${String.fromCharCode(65 + index)}`;
    fragment.querySelector('.node-name').textContent = `Node ${index + 1}`;
    fragment.querySelector('.node-badge').className = `node-badge badge ${status.level}`;
    fragment.querySelector('.node-badge').textContent = status.label;

    if (!node) {
      fragment.querySelector('.node-id').textContent = 'No device discovered';
      fragment.querySelector('.node-state').textContent = 'Missing';
      fragment.querySelector('.node-age').textContent = 'Waiting for UDP datagrams';
      fragment.querySelector('.node-rate').textContent = '0.0 Hz';
      fragment.querySelector('.node-baseline-value').textContent = '0%';
      fragment.querySelector('.node-confidence').textContent = '0%';
      fragment.querySelector('.node-motion').textContent = '0.0000';
      fragment.querySelector('.node-activation').textContent = '0%';
      fragment.querySelector('.node-loss').textContent = '0 ppm';
      for (const selector of [
        '.node-datagrams',
        '.node-frames',
        '.node-invalid',
        '.node-missing',
        '.node-duplicate',
        '.node-out-of-order',
      ]) {
        fragment.querySelector(selector).textContent = '0';
      }
      fragment.querySelector('.node-reasons').textContent =
        'This slot has not received a node stream.';
      fragment.querySelector('.node-boot').textContent = 'Boot ID —';
      fragment.querySelector('.node-reset-button').disabled = true;
      drawProfile(fragment.querySelector('.node-profile'), [], false);
      root.append(fragment);
      return;
    }

    const diagnostics = node.diagnostics || {};
    fragment.querySelector('.node-id').textContent = `Device ${node.deviceId}`;
    fragment.querySelector('.node-state').textContent = labelState(node.state);
    fragment.querySelector('.node-age').textContent = finite(node.ageSec)
      ? `Updated ${number(node.ageSec).toFixed(2)}s ago`
      : 'No recent frame';
    fragment.querySelector('.node-rate').textContent = `${number(node.frameRateHz).toFixed(1)} Hz`;
    fragment.querySelector('.node-baseline-value').textContent = percent(
      diagnostics.baselineProgress,
    );
    fragment.querySelector('.node-baseline-bar').style.width = percent(
      diagnostics.baselineProgress,
    );
    fragment.querySelector('.node-confidence').textContent = percent(node.confidence);
    fragment.querySelector('.node-motion').textContent = number(node.motion).toFixed(4);
    fragment.querySelector('.node-activation').textContent = percent(diagnostics.activationScore);
    fragment.querySelector('.node-loss').textContent = `${integer(node.lossPpm)} ppm`;
    fragment.querySelector('.node-datagrams').textContent = integer(node.datagrams);
    fragment.querySelector('.node-frames').textContent = integer(node.frames);
    fragment.querySelector('.node-invalid').textContent = integer(node.invalidDatagrams);
    fragment.querySelector('.node-missing').textContent = integer(node.missingPackets);
    fragment.querySelector('.node-duplicate').textContent = integer(node.duplicatePackets);
    fragment.querySelector('.node-out-of-order').textContent = integer(node.outOfOrderPackets);
    fragment.querySelector('.node-reasons').textContent = (node.readinessReasons || []).join('; ');
    fragment.querySelector('.node-boot').textContent = `Boot ID ${node.bootId || '—'}`;
    const resetButton = fragment.querySelector('.node-reset-button');
    resetButton.dataset.deviceId = node.deviceId;
    resetButton.addEventListener('click', () => void resetBaseline(node.deviceId, resetButton));
    drawProfile(fragment.querySelector('.node-profile'), node.amplitudeProfile || [], false);
    root.append(fragment);
  });
}

function renderReadiness(snapshot) {
  const readiness = snapshot?.readiness || {};
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const ready = number(readiness.onlineNodeCount);
  const required = number(readiness.requiredNodeCount, 4);
  const badge = get('readinessBadge');
  const banner = get('diagnosticBanner');

  if (readiness.readyForCapture) {
    badge.className = 'badge ready';
    badge.textContent = 'Ready';
    banner.className = 'diagnostic-banner good';
    banner.textContent = `${ready} of ${required} nodes are healthy. Training capture is enabled.`;
  } else if (nodes.length > 0) {
    badge.className = 'badge issue';
    badge.textContent = 'Blocked';
    banner.className = 'diagnostic-banner warn';
    banner.textContent =
      (readiness.reasons || []).join('; ') || `${ready} of ${required} nodes are ready.`;
  } else {
    badge.className = 'badge neutral';
    badge.textContent = 'Waiting';
    banner.className = 'diagnostic-banner bad';
    banner.textContent = 'No RF nodes have reached the collector.';
  }
}

function renderCapabilities(values) {
  const root = get('capabilityList');
  root.replaceChildren();
  for (const [key, enabled] of Object.entries(values || {})) {
    const chip = document.createElement('span');
    chip.className = `capability ${enabled ? 'on' : ''}`;
    chip.textContent = `${enabled ? '✓' : '○'} ${key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}`;
    root.append(chip);
  }
}

function renderRecording(recording) {
  latestRecording = recording || {};
  const badge = get('recordingBadge');
  const status = get('recordingStatus');
  if (latestRecording.active) {
    badge.className = 'badge active';
    badge.textContent = 'Recording';
    status.textContent = `${latestRecording.label}: ${number(latestRecording.elapsedSeconds).toFixed(0)}s / ${integer(latestRecording.targetSeconds)}s, ${integer(latestRecording.frames)} / ${integer(latestRecording.targetFrames)} frames, ${percent(latestRecording.progress)}`;
  } else if (latestRecording.name) {
    badge.className = 'badge ready';
    badge.textContent = 'Saved';
    status.textContent = `Saved ${latestRecording.name}, ${integer(latestRecording.datagrams)} datagrams and ${integer(latestRecording.frames)} frames.`;
  } else {
    badge.className = 'badge neutral';
    badge.textContent = 'Idle';
    status.textContent =
      latestRecording.error ||
      'No recording active. Recordings stop automatically after 90 seconds and 2,000 frames.';
  }
  updateRecordingControls();
}

function updateRecordingControls() {
  const ready = Boolean(latestSnapshot?.readiness?.readyForCapture);
  const active = Boolean(latestRecording?.active);
  document.querySelectorAll('[data-recording-label]').forEach((button) => {
    button.disabled = !ready || active;
    button.title = !ready ? 'All four nodes must be ready before recording.' : '';
  });
  get('stopRecordingButton').disabled = !active;
}

async function startRecording(label, button) {
  button.disabled = true;
  get('recordingStatus').textContent = `${button.textContent} starting...`;
  try {
    renderRecording(
      await json('/api/recording/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, targetSeconds: 90, targetFrames: 2000 }),
      }),
    );
  } catch (error) {
    get('recordingStatus').textContent = error.message;
    updateRecordingControls();
  }
}

async function stopRecording() {
  get('stopRecordingButton').disabled = true;
  get('recordingStatus').textContent = 'Stopping recording...';
  try {
    renderRecording(await json('/api/recording/stop', { method: 'POST' }));
  } catch (error) {
    get('recordingStatus').textContent = error.message;
    updateRecordingControls();
  }
}

async function resetBaseline(deviceId, button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Resetting...';
  try {
    await json('/api/baseline/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(deviceId ? { deviceId } : {}),
    });
    button.textContent = 'Baseline reset';
  } catch (error) {
    button.textContent = error.message;
  } finally {
    setTimeout(() => {
      button.textContent = label;
      button.disabled = false;
    }, 1200);
  }
}

function drawProfile(svg, values, large) {
  svg.replaceChildren();
  const width = large ? 1000 : 400;
  const height = large ? 240 : 90;
  const pad = large ? 26 : 8;
  drawGrid(svg, width, height, large ? 5 : 3);
  const clean = values.map(Number).filter(Number.isFinite);
  if (clean.length < 2) {
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', width / 2);
    text.setAttribute('y', height / 2);
    text.setAttribute('class', 'empty-chart-label');
    text.textContent = 'Waiting for CSI profile';
    svg.append(text);
    return;
  }
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = Math.max(1e-9, max - min);
  const points = clean.map((value, index) => {
    const x = pad + (index / (clean.length - 1)) * (width - pad * 2);
    const y = height - pad - ((value - min) / span) * (height - pad * 2);
    return [x, y];
  });
  const lineD = points
    .map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(' ');
  const fillD = `${lineD} L${points.at(-1)[0].toFixed(2)},${height - pad} L${points[0][0].toFixed(2)},${height - pad} Z`;
  const fill = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  fill.setAttribute('d', fillD);
  fill.setAttribute('class', 'chart-profile-fill');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', lineD);
  line.setAttribute('class', 'chart-profile-line');
  svg.append(fill, line);
}

function drawGrid(svg, width, height, rows) {
  for (let index = 1; index < rows; index++) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    const y = (height / rows) * index;
    line.setAttribute('x1', 0);
    line.setAttribute('x2', width);
    line.setAttribute('y1', y);
    line.setAttribute('y2', y);
    line.setAttribute('class', 'chart-grid-line');
    svg.append(line);
  }
}

function addHistory(state) {
  if (!state) return;
  history.push({
    timestamp: number(state.timestamp, Date.now() / 1000),
    motion: number(state.motion),
    confidence: number(state.confidence),
  });
  while (history.length > 240) history.shift();
  drawHistory();
}

function drawHistory() {
  const svg = get('historyChart');
  svg.replaceChildren();
  drawGrid(svg, 1000, 240, 5);
  if (history.length < 2) {
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', 500);
    text.setAttribute('y', 120);
    text.setAttribute('class', 'empty-chart-label');
    text.textContent = 'Waiting for rolling history';
    svg.append(text);
    return;
  }
  const pad = 26;
  const maxMotion = Math.max(0.001, ...history.map((point) => point.motion));
  const makePath = (selector, max) =>
    history
      .map((point, index) => {
        const x = pad + (index / (history.length - 1)) * (1000 - pad * 2);
        const y = 240 - pad - (selector(point) / max) * (240 - pad * 2);
        return `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  const motion = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  motion.setAttribute(
    'd',
    makePath((point) => point.motion, maxMotion),
  );
  motion.setAttribute('class', 'chart-motion');
  const confidence = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  confidence.setAttribute(
    'd',
    makePath((point) => point.confidence, 1),
  );
  confidence.setAttribute('class', 'chart-confidence');
  svg.append(motion, confidence);
}

function updateStreamStatus() {
  const age = lastStreamEventAt ? (Date.now() - lastStreamEventAt) / 1000 : Infinity;
  const dot = get('streamDot');
  if (streamConnected && age <= 3) {
    dot.className = 'live';
    get('streamStatus').textContent = `Live, ${age.toFixed(1)}s`;
  } else if (lastStreamEventAt) {
    dot.className = 'stale';
    get('streamStatus').textContent = `Stale, ${age.toFixed(1)}s`;
  } else {
    dot.className = '';
    get('streamStatus').textContent = streamConnected ? 'Waiting for data' : 'Reconnecting';
  }
}

async function boot() {
  const [meta, snapshot, historical, recording] = await Promise.all([
    json('/api/meta'),
    json('/api/nodes'),
    optionalJson('/api/history?seconds=120'),
    optionalJson('/api/recording'),
  ]);
  renderCapabilities(meta.capabilities);
  get('systemCaveat').textContent = meta.disclaimer;
  for (const item of historical || []) addHistory(item);
  renderSnapshot(snapshot);
  renderRecording(recording || {});

  document.querySelectorAll('[data-recording-label]').forEach((button) => {
    button.addEventListener(
      'click',
      () => void startRecording(button.dataset.recordingLabel, button),
    );
  });
  get('stopRecordingButton').addEventListener('click', () => void stopRecording());
  get('resetAllButton').addEventListener(
    'click',
    () => void resetBaseline(null, get('resetAllButton')),
  );

  const stream = new EventSource('/events');
  stream.onopen = () => {
    streamConnected = true;
    updateStreamStatus();
  };
  stream.addEventListener('state', (event) => {
    const fused = JSON.parse(event.data);
    addHistory(fused);
  });
  stream.addEventListener('nodes', (event) => renderSnapshot(JSON.parse(event.data)));
  stream.addEventListener('recording', (event) => renderRecording(JSON.parse(event.data)));
  stream.onerror = () => {
    streamConnected = false;
    updateStreamStatus();
  };
  setInterval(updateStreamStatus, 1000);
}

boot().catch((error) => {
  get('streamStatus').textContent = error.message;
  get('diagnosticBanner').className = 'diagnostic-banner bad';
  get('diagnosticBanner').textContent = error.message;
  renderNodeGrid([null, null, null, null]);
});
