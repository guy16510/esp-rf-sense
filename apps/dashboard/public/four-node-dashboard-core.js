const get = (id) => document.getElementById(id);
const template = get('nodeCardTemplate');
const dashboardStream = window.RfSenseDashboardStream;
const slotAssignments = new Map();
const history = [];

let latestSnapshot = null;
let latestRecording = null;
let latestModel = null;
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

function predictedLabel(node) {
  const scores = node?.scores || {};
  const entries = Object.entries(scores).filter(([, value]) => finite(value));
  if (entries.length === 0) return null;
  entries.sort((left, right) => number(right[1]) - number(left[1]));
  return entries[0][0];
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

function allocateSlots(nodes, requiredCount, slotDeviceIds = []) {
  const explicitIds = slotDeviceIds.map((id) => String(id || '').toLowerCase()).filter(Boolean);
  const count = Math.max(4, requiredCount || 4, explicitIds.length);
  const slots = Array(count).fill(null);
  const assigned = new Set();

  if (explicitIds.length > 0) {
    for (const node of nodes) {
      const id = String(node.deviceId || '').toLowerCase();
      const slot = explicitIds.indexOf(id);
      if (slot >= 0 && slot < count) {
        slots[slot] = node;
        assigned.add(id);
      }
    }
    return slots;
  }

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

  renderNodeGrid(
    allocateSlots(nodes, required, snapshot?.slotDeviceIds || []),
    snapshot?.slotDeviceIds || [],
  );
  drawProfile(get('fusedProfile'), fused.amplitudeProfile || [], true);
  renderReadiness(snapshot);
  updateRecordingControls();
}

function renderNodeGrid(slots, slotDeviceIds = []) {
  const root = get('nodeGrid');
  ensureNodeCards(root, 4);
  slots.slice(0, 4).forEach((node, index) => {
    const expectedDeviceId = slotDeviceIds[index];
    const card = root.children[index];
    const status = classifyNode(node);
    card.className = `node-card ${status.level}`;
    card.querySelector('.node-slot').textContent = `Receiver ${String.fromCharCode(65 + index)}`;
    card.querySelector('.node-name').textContent = `Node ${index + 1}`;
    card.querySelector('.node-badge').className = `node-badge badge ${status.level}`;
    card.querySelector('.node-badge').textContent = status.label;

    if (!node) {
      card.querySelector('.node-id').textContent = expectedDeviceId
        ? `Expected device ${expectedDeviceId}`
        : 'No device discovered';
      card.querySelector('.node-state').textContent = 'Missing';
      card.querySelector('.node-age').textContent = 'Waiting for UDP datagrams';
      card.querySelector('.node-rate').textContent = '0.0 Hz';
      card.querySelector('.node-baseline-value').textContent = '0%';
      card.querySelector('.node-baseline-bar').style.width = '0%';
      card.querySelector('.node-confidence').textContent = '0%';
      card.querySelector('.node-motion').textContent = '0.0000';
      card.querySelector('.node-activation').textContent = '0%';
      card.querySelector('.node-loss').textContent = '0 ppm';
      for (const selector of [
        '.node-datagrams',
        '.node-frames',
        '.node-invalid',
        '.node-missing',
        '.node-duplicate',
        '.node-out-of-order',
      ]) {
        card.querySelector(selector).textContent = '0';
      }
      card.querySelector('.node-reasons').textContent =
        expectedDeviceId
          ? 'This hard-coded slot has not received its expected node stream.'
          : 'This slot has not received a node stream.';
      card.querySelector('.node-boot').textContent = 'Boot ID —';
      card.querySelector('.node-reset-button').disabled = true;
      card.querySelector('.node-reset-button').onclick = null;
      drawProfile(card.querySelector('.node-profile'), [], false);
      return;
    }

    const diagnostics = node.diagnostics || {};
    card.querySelector('.node-id').textContent = `Device ${node.deviceId}`;
    card.querySelector('.node-state').textContent =
      node.mode === 'portable-model' ? predictedLabel(node) || labelState(node.state) : labelState(node.state);
    card.querySelector('.node-age').textContent = finite(node.ageSec)
      ? `Updated ${number(node.ageSec).toFixed(2)}s ago`
      : 'No recent frame';
    card.querySelector('.node-rate').textContent = `${number(node.frameRateHz).toFixed(1)} Hz`;
    card.querySelector('.node-baseline-value').textContent = percent(
      diagnostics.baselineProgress,
    );
    card.querySelector('.node-baseline-bar').style.width = percent(
      diagnostics.baselineProgress,
    );
    card.querySelector('.node-confidence').textContent = percent(node.confidence);
    card.querySelector('.node-motion').textContent = number(node.motion).toFixed(4);
    card.querySelector('.node-activation').textContent = percent(diagnostics.activationScore);
    card.querySelector('.node-loss').textContent = `${integer(node.lossPpm)} ppm`;
    card.querySelector('.node-datagrams').textContent = integer(node.datagrams);
    card.querySelector('.node-frames').textContent = integer(node.frames);
    card.querySelector('.node-invalid').textContent = integer(node.invalidDatagrams);
    card.querySelector('.node-missing').textContent = integer(node.missingPackets);
    card.querySelector('.node-duplicate').textContent = integer(node.duplicatePackets);
    card.querySelector('.node-out-of-order').textContent = integer(node.outOfOrderPackets);
    card.querySelector('.node-reasons').textContent = (node.readinessReasons || []).join('; ');
    card.querySelector('.node-boot').textContent =
      `Boot ID ${node.bootId || '—'} · ${node.canonicalStreamKey || 'no stream'}`;
    const resetButton = card.querySelector('.node-reset-button');
    resetButton.dataset.deviceId = node.deviceId;
    resetButton.disabled = false;
    resetButton.onclick = () => void resetBaseline(node.deviceId, resetButton);
    drawProfile(card.querySelector('.node-profile'), node.amplitudeProfile || [], false);
  });
}

function ensureNodeCards(root, count) {
  while (root.children.length < count) {
    root.append(template.content.cloneNode(true));
  }
  while (root.children.length > count) {
    root.lastElementChild?.remove();
  }
}

function renderReadiness(snapshot) {
  const readiness = snapshot?.readiness || {};
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const unexpected = Array.isArray(snapshot?.unexpectedDeviceIds) ? snapshot.unexpectedDeviceIds : [];
  const ready = number(readiness.onlineNodeCount);
  const required = number(readiness.requiredNodeCount, 4);
  const badge = get('readinessBadge');
  const banner = get('diagnosticBanner');
  const suffix =
    unexpected.length > 0 ? ` Unexpected devices: ${unexpected.join(', ')}.` : '';

  if (readiness.readyForCapture) {
    badge.className = 'badge ready';
    badge.textContent = 'Ready';
    banner.className = 'diagnostic-banner good';
    banner.textContent = `${ready} of ${required} nodes are healthy. Training capture is enabled.${suffix}`;
  } else if (nodes.length > 0) {
    badge.className = 'badge issue';
    badge.textContent = 'Blocked';
    banner.className = 'diagnostic-banner warn';
    banner.textContent =
      `${(readiness.reasons || []).join('; ') || `${ready} of ${required} nodes are ready.`}${suffix}`;
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

function renderModel(model) {
  latestModel = model || {};
  const badge = get('modelBadge');
  const status = get('modelStatus');
  const labels = get('modelLabels');
  labels.replaceChildren();

  if (latestModel.loaded) {
    badge.className = 'badge ready';
    badge.textContent = 'Loaded';
    const classes = Array.isArray(latestModel.classes) ? latestModel.classes : [];
    status.textContent = `Loaded ${latestModel.target || 'label'} model from ${latestModel.path || 'saved model'}${latestModel.windows ? ` using ${integer(latestModel.windows)} windows` : ''}.`;
    for (const label of classes) {
      const chip = document.createElement('span');
      chip.className = 'model-label';
      chip.textContent = label;
      labels.append(chip);
    }
  } else {
    badge.className = latestModel.error ? 'badge issue' : 'badge neutral';
    badge.textContent = latestModel.error ? 'Error' : 'Not loaded';
    status.textContent =
      latestModel.error ||
      'Train a label model from saved empty, moving, and stationary recordings.';
  }
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

async function trainModel() {
  const button = get('trainModelButton');
  button.disabled = true;
  get('loadModelButton').disabled = true;
  get('modelStatus').textContent = 'Training label model from saved recordings...';
  try {
    renderModel(
      await json('/api/model/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'label', window: 64, step: 32 }),
      }),
    );
  } catch (error) {
    renderModel({ loaded: false, error: error.message, classes: [] });
  } finally {
    button.disabled = false;
    get('loadModelButton').disabled = false;
  }
}

async function loadModel() {
  const button = get('loadModelButton');
  button.disabled = true;
  get('modelStatus').textContent = 'Loading latest model...';
  try {
    renderModel(await json('/api/model/load', { method: 'POST' }));
  } catch (error) {
    renderModel({ loaded: false, error: error.message, classes: [] });
  } finally {
    button.disabled = false;
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
  const width = large ? 1000 : 400;
  const height = large ? 240 : 90;
  const pad = large ? 26 : 8;
  ensureGrid(svg, width, height, large ? 5 : 3);
  const clean = values.map(Number).filter(Number.isFinite);
  const empty = ensureSvg(svg, 'text', 'empty-chart-label');
  const fill = ensureSvg(svg, 'path', 'chart-profile-fill');
  const line = ensureSvg(svg, 'path', 'chart-profile-line');
  if (clean.length < 2) {
    empty.setAttribute('x', width / 2);
    empty.setAttribute('y', height / 2);
    empty.textContent = 'Waiting for CSI profile';
    empty.removeAttribute('hidden');
    fill.setAttribute('hidden', '');
    line.setAttribute('hidden', '');
    return;
  }
  empty.setAttribute('hidden', '');
  fill.removeAttribute('hidden');
  line.removeAttribute('hidden');
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
  fill.setAttribute('d', fillD);
  line.setAttribute('d', lineD);
}

function ensureGrid(svg, width, height, rows) {
  const existing = [...svg.querySelectorAll('.chart-grid-line')];
  while (existing.length < rows - 1) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('class', 'chart-grid-line');
    svg.prepend(line);
    existing.push(line);
  }
  for (const line of existing.slice(rows - 1)) line.remove();
  for (let index = 1; index < rows; index++) {
    const line = existing[index - 1];
    const y = (height / rows) * index;
    line.setAttribute('x1', 0);
    line.setAttribute('x2', width);
    line.setAttribute('y1', y);
    line.setAttribute('y2', y);
  }
}

function ensureSvg(svg, tag, className) {
  let node = svg.querySelector(`.${className}`);
  if (!node) {
    node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    node.setAttribute('class', className);
    if (tag === 'text') node.setAttribute('text-anchor', 'middle');
    svg.append(node);
  }
  return node;
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
  ensureGrid(svg, 1000, 240, 5);
  const empty = ensureSvg(svg, 'text', 'empty-chart-label');
  const motion = ensureSvg(svg, 'path', 'chart-motion');
  const confidence = ensureSvg(svg, 'path', 'chart-confidence');
  if (history.length < 2) {
    empty.setAttribute('x', 500);
    empty.setAttribute('y', 120);
    empty.textContent = 'Waiting for rolling history';
    empty.removeAttribute('hidden');
    motion.setAttribute('hidden', '');
    confidence.setAttribute('hidden', '');
    return;
  }
  empty.setAttribute('hidden', '');
  motion.removeAttribute('hidden');
  confidence.removeAttribute('hidden');
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
  motion.setAttribute(
    'd',
    makePath((point) => point.motion, maxMotion),
  );
  confidence.setAttribute(
    'd',
    makePath((point) => point.confidence, 1),
  );
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
  const [meta, snapshot, historical, recording, model] = await Promise.all([
    json('/api/meta'),
    json('/api/nodes'),
    optionalJson('/api/history?seconds=120'),
    optionalJson('/api/recording'),
    optionalJson('/api/model'),
  ]);
  renderCapabilities(meta.capabilities);
  get('systemCaveat').textContent = meta.disclaimer;
  for (const item of historical || []) addHistory(item);
  renderSnapshot(snapshot);
  renderRecording(recording || {});
  renderModel(model || {});

  document.querySelectorAll('[data-recording-label]').forEach((button) => {
    button.addEventListener(
      'click',
      () => void startRecording(button.dataset.recordingLabel, button),
    );
  });
  get('stopRecordingButton').addEventListener('click', () => void stopRecording());
  get('trainModelButton').addEventListener('click', () => void trainModel());
  get('loadModelButton').addEventListener('click', () => void loadModel());
  get('resetAllButton').addEventListener(
    'click',
    () => void resetBaseline(null, get('resetAllButton')),
  );

  dashboardStream?.on('open', () => {
    streamConnected = true;
    updateStreamStatus();
  });
  dashboardStream?.on('snapshot', (snapshot) => {
    renderSnapshot(snapshot);
    addHistory(snapshot.fused || {});
  });
  dashboardStream?.on('recording', (recording) => renderRecording(recording));
  dashboardStream?.on('model', (model) => renderModel(model));
  dashboardStream?.on('close', () => {
    streamConnected = false;
    updateStreamStatus();
  });
  setInterval(updateStreamStatus, 1000);
}

boot().catch((error) => {
  get('streamStatus').textContent = error.message;
  get('diagnosticBanner').className = 'diagnostic-banner bad';
  get('diagnosticBanner').textContent = error.message;
  renderNodeGrid([null, null, null, null]);
});
