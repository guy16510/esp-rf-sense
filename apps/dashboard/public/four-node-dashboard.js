import './dashboard-stream.js';
import './four-node-dashboard-core.js';
import './room-d3.js';

const POSITION_PREFIX = 'rfsense-meta:';
const positionState = {
  snapshot: null,
  recording: null,
  model: null,
  smoothed: null,
  trail: [],
};
const dashboardStream = window.RfSenseDashboardStream;

injectPositionStyles();
installPositionControls();
connectPositionStream();
void loadInitialPositionState();

function get(id) {
  return document.getElementById(id);
}

function installPositionControls() {
  const capturePanel = document.querySelector('.operations-panel');
  const body = capturePanel?.querySelector('.operation-body');
  if (!body || get('positionCaptureForm')) return;

  capturePanel.querySelector('h2').textContent = 'Position training recordings';
  const originalButtons = body.querySelector('.button-row');
  originalButtons?.querySelectorAll('[data-recording-label]').forEach((button) => {
    button.hidden = true;
  });

  const form = document.createElement('div');
  form.id = 'positionCaptureForm';
  form.className = 'position-capture-form';
  form.innerHTML = `
    <div class="position-form-copy">
      <strong>Record a calibrated XY point</strong>
      <small>Coordinates are measured in meters from the room origin. Zone names are optional annotations.</small>
    </div>
    <div class="position-field-grid">
      <label>Point annotation<input id="positionLabel" value="grid-1" autocomplete="off" /></label>
      <label>Person ID<input id="positionSubject" value="person-1" autocomplete="off" /></label>
      <label>Day<input id="positionDay" type="date" /></label>
      <label>Movement<select id="positionMovement"><option value="stationary">Stationary</option><option value="moving">Moving slowly</option></select></label>
      <label>X meters<input id="positionX" type="number" min="0" step="0.05" value="2.00" /></label>
      <label>Y meters<input id="positionY" type="number" min="0" step="0.05" value="1.50" /></label>
    </div>
    <div class="position-button-row">
      <button id="recordEmptyPosition" type="button">Record empty room</button>
      <button id="recordPositionZone" type="button">Record this XY point</button>
    </div>
    <p id="positionCaptureHint" class="muted">Collect empty-room sessions plus a meter-spaced calibration grid before training continuous XY.</p>
  `;
  body.insertBefore(form, originalButtons || body.firstChild);
  get('positionDay').value = new Date().toISOString().slice(0, 10);
  get('recordEmptyPosition').addEventListener('click', () => void startPositionRecording(true));
  get('recordPositionZone').addEventListener('click', () => void startPositionRecording(false));

  const modelPanel = [...document.querySelectorAll('.operations-panel')].find((panel) =>
    panel.querySelector('#trainModelButton'),
  );
  if (modelPanel) {
    modelPanel.querySelector('h2').textContent = 'Coarse zone fallback';
    get('trainModelButton').textContent = 'Train position model';
    get('modelStatus').textContent =
      'Train from labelled empty-room and occupied-zone recordings. The output is a coarse zone estimate, not camera-like tracking.';
    get('trainModelButton').addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        void trainPositionModel();
      },
      true,
    );
  }

  const overview = document.querySelector('.overview-grid');
  if (overview && !get('positionSummaryCard')) {
    const card = document.createElement('article');
    card.id = 'positionSummaryCard';
    card.className = 'summary-card position-summary-card';
    card.innerHTML = `
      <span>Position estimate</span>
      <strong id="positionZone">Not available</strong>
      <small id="positionEvidence">Load a position model</small>
      <div class="position-mini-metrics">
        <span><b id="positionConfidence">0%</b> confidence</span>
        <span><b id="positionAgreement">0%</b> overlap</span>
      </div>
    `;
    overview.append(card);
  }
}

async function loadInitialPositionState() {
  const [snapshot, recording, model] = await Promise.all([
    optionalJson('/api/nodes'),
    optionalJson('/api/recording'),
    optionalJson('/api/model'),
  ]);
  if (recording) positionState.recording = recording;
  if (model) positionState.model = model;
  if (snapshot) renderPositionSnapshot(snapshot);
  updatePositionControls();
}

function connectPositionStream() {
  dashboardStream?.on('snapshot', renderPositionSnapshot);
  dashboardStream?.on('recording', (recording) => {
    positionState.recording = recording;
    updatePositionControls();
  });
  dashboardStream?.on('model', (model) => {
    positionState.model = model;
    renderPositionSnapshot(positionState.snapshot);
  });
}

function renderPositionSnapshot(snapshot) {
  if (!snapshot) return;
  positionState.snapshot = snapshot;
  const fused = snapshot.fused || {};
  const position = fused.position || null;
  const continuousModel = fused.modelTarget === 'continuous-xy' || positionState.model?.target === 'continuous-xy';
  const coarseModel =
    fused.modelTarget === 'coarse-zones' ||
    fused.modelTarget === 'position' ||
    positionState.model?.target === 'coarse-zones' ||
    positionState.model?.target === 'position';
  const positionModel = continuousModel || coarseModel;
  const accepted = Boolean(positionModel && position?.accepted && finite(position.x) && finite(position.y));

  const zone = get('positionZone');
  const evidence = get('positionEvidence');
  if (zone && evidence) {
    if (continuousModel && accepted) {
      zone.textContent = `X ${meters(position.xMeters)}  Y ${meters(position.yMeters)}`;
      evidence.textContent = `Uncertainty ±${meters(position.uncertaintyMeters)}, ${position.receiverCount || position.contributors} receivers, ${percent(position.packetOverlap ?? position.agreement)} packet overlap`;
    } else if (continuousModel) {
      zone.textContent = 'Position unavailable';
      evidence.textContent = `Reason: ${position?.reason || 'waiting for accepted continuous XY estimate'}`;
    } else if (coarseModel && accepted) {
      zone.textContent = `Likely zone: ${position.zone || 'unknown'}`;
      evidence.textContent = 'Continuous XY model not loaded';
    } else {
      zone.textContent = coarseModel ? 'No accepted coarse zone' : 'Not available';
      evidence.textContent = position?.reason || (positionModel ? 'Waiting for receiver agreement' : 'Load a position model');
    }
    get('positionConfidence').textContent = percent(position?.confidence);
    get('positionAgreement').textContent = percent(position?.packetOverlap ?? position?.agreement);
  }

  renderRoomPosition({ positionModel, continuousModel, coarseModel }, accepted ? position : null, fused);
  renderNodePositionLabels(snapshot);
  updatePositionControls();
}

function renderRoomPosition(modes, position, fused) {
  const svg = document.querySelector('#roomD3');
  const panel = document.querySelector('.rf-room-panel');
  if (!svg || !panel) {
    setTimeout(() => renderPositionSnapshot(positionState.snapshot), 100);
    return;
  }
  panel.classList.toggle('position-model-active', modes.positionModel);
  let layer = svg.querySelector('#trainedPositionLayer');
  if (!layer) {
    layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.id = 'trainedPositionLayer';
    layer.innerHTML = `
      <g class="trained-position-trail"></g>
      <circle class="trained-position-halo" r="66"></circle>
      <circle class="trained-position-core" r="28"></circle>
      <text class="trained-position-label" text-anchor="middle" dy="5"></text>
    `;
    svg.append(layer);
  }

  if (!position) {
    positionState.smoothed = null;
    positionState.trail = [];
    layer.setAttribute('hidden', '');
  } else {
    layer.removeAttribute('hidden');
    const smooth = smoothPosition(position);
    const x = 62 + clamp(smooth.x) * 776;
    const y = 62 + clamp(smooth.y) * 486;
    const uncertaintyMeters = Number(position.uncertaintyMeters ?? 0);
    const roomMeters = Math.max(1, Number(position.xMeters || 0) / Math.max(0.001, Number(position.x || 0.5)), Number(position.yMeters || 0) / Math.max(0.001, Number(position.y || 0.5)));
    const uncertaintyRadius = modes.continuousModel
      ? Math.max(18, Math.min(180, (uncertaintyMeters / roomMeters) * 776))
      : 66;
    layer.setAttribute('transform', `translate(${x.toFixed(2)},${y.toFixed(2)})`);
    layer.querySelector('.trained-position-halo').setAttribute('r', uncertaintyRadius.toFixed(1));
    layer.querySelector('text').textContent = modes.continuousModel
      ? `${meters(position.xMeters)}, ${meters(position.yMeters)}`
      : position.zone || 'zone';
    layer.style.setProperty('--position-confidence', clamp(position.confidence));
    renderTrail(layer, smooth);
  }

  const mode = panel.querySelector('.rf-room-actions .badge');
  const roomState = panel.querySelector('.rf-room-footer strong');
  const roomNote = panel.querySelector('.rf-room-footer small');
  if (mode) mode.textContent = modes.continuousModel ? 'Continuous estimated XY' : modes.coarseModel ? 'Coarse zones' : 'Heuristic disturbance';
  if (roomState && modes.positionModel) {
    roomState.textContent = position
      ? modes.continuousModel
        ? `Estimated XY: ${meters(position.xMeters)}, ${meters(position.yMeters)}`
        : `Likely zone: ${position.zone}`
      : fused.state === 'clear'
        ? 'Room clear'
        : 'Position unavailable';
  }
  if (roomNote && modes.positionModel) {
    roomNote.textContent = position
      ? modes.continuousModel
        ? `Uncertainty ±${meters(position.uncertaintyMeters)}, ${position.receiverCount || position.contributors} receivers, ${percent(position.packetOverlap ?? position.agreement)} packet overlap.`
        : `${percent(position.confidence)} confidence, ${percent(position.agreement)} receiver agreement.`
      : fused.position?.reason || 'No marker is shown until the trained model passes confidence and agreement gates.';
  }
}

function renderNodePositionLabels(snapshot) {
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  for (const card of document.querySelectorAll('.node-card')) {
    const idText = card.querySelector('.node-id')?.textContent || '';
    const node = nodes.find((candidate) => idText.includes(String(candidate.deviceId || '')));
    if (!node || (node.modelTarget !== 'coarse-zones' && node.modelTarget !== 'position')) continue;
    const state = card.querySelector('.node-state');
    if (state) {
      state.textContent = node.position?.accepted
        ? node.position.zone || 'Accepted zone'
        : node.state === 'clear'
          ? 'Clear'
          : 'Unknown zone';
    }
    if (node.position?.reason && node.state !== 'clear') {
      const reasons = card.querySelector('.node-reasons');
      if (reasons && !reasons.textContent.includes(node.position.reason)) {
        reasons.textContent = [reasons.textContent, node.position.reason].filter(Boolean).join('; ');
      }
    }
  }
}

async function startPositionRecording(empty) {
  const label = String(get('positionLabel').value || '').trim().toLowerCase();
  const subjectId = String(get('positionSubject').value || '').trim();
  const day = String(get('positionDay').value || '').trim();
  const movement = String(get('positionMovement').value || '').trim();
  const x = Number(get('positionX').value);
  const y = Number(get('positionY').value);
  const hint = get('positionCaptureHint');

  if (!day) return showCaptureError('Select the recording day.');
  if (!empty && !label) return showCaptureError('Enter a stable zone label.');
  if (!empty && !subjectId) return showCaptureError('Enter a person ID for occupied recordings.');
  if (!empty && (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0)) {
    return showCaptureError('X and Y must be non-negative meter coordinates.');
  }

  const metadata = {
    label: empty ? 'empty' : `occupied-${label}`,
    target: 'continuous-xy',
    recordingId: empty ? `empty-${Date.now()}` : `${label}-${x}-${y}-${Date.now()}`,
    subjectId: empty ? undefined : subjectId,
    day,
    movement: empty ? 'empty' : movement,
    zoneAnnotation: empty ? undefined : label,
    xMeters: empty ? undefined : x,
    yMeters: empty ? undefined : y,
    orientationDegrees: 0,
  };
  hint.textContent = empty ? 'Starting empty-room capture...' : `Starting ${label} capture...`;
  try {
    positionState.recording = await post('/api/recording/start', {
      label: encodeMetadata(metadata),
      targetSeconds: 90,
      targetFrames: 2000,
    });
    hint.textContent = empty
      ? 'Recording empty room. Keep people out of the sensing area.'
      : `Recording ${label} at X ${x.toFixed(2)} m, Y ${y.toFixed(2)} m.`;
  } catch (error) {
    showCaptureError(error.message);
  }
  updatePositionControls();
}

async function trainPositionModel() {
  const button = get('trainModelButton');
  button.disabled = true;
  get('loadModelButton').disabled = true;
  get('modelStatus').textContent = 'Training leakage-safe position model from grouped recordings...';
  try {
    positionState.model = await post('/api/model/train', {
      target: 'position',
      window: 64,
      step: 32,
      minRecordingsPerClass: 2,
    });
    get('modelStatus').textContent = `Loaded coarse-zone model with ${(positionState.model.classes || []).length} classes from ${positionState.model.recordings || 0} recordings.`;
    get('modelBadge').className = 'badge ready';
    get('modelBadge').textContent = 'Coarse zones loaded';
  } catch (error) {
    get('modelStatus').textContent = error.message;
    get('modelBadge').className = 'badge issue';
    get('modelBadge').textContent = 'Training failed';
  } finally {
    button.disabled = false;
    get('loadModelButton').disabled = false;
  }
}

function updatePositionControls() {
  const ready = Boolean(positionState.snapshot?.readiness?.readyForCapture);
  const active = Boolean(positionState.recording?.active);
  for (const id of ['recordEmptyPosition', 'recordPositionZone']) {
    const button = get(id);
    if (!button) continue;
    button.disabled = !ready || active;
    button.title = !ready ? 'All required receivers must be healthy before recording.' : '';
  }
}

function showCaptureError(message) {
  get('positionCaptureHint').textContent = message;
}

function encodeMetadata(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${POSITION_PREFIX}${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || response.statusText);
  return value;
}

async function optionalJson(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function finite(value) {
  return Number.isFinite(Number(value));
}

function clamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0;
}

function smoothPosition(position) {
  const now = Date.now();
  const target = { x: clamp(position.x), y: clamp(position.y), t: now };
  const previous = positionState.smoothed;
  if (!previous) {
    positionState.smoothed = target;
    positionState.trail = [target];
    return target;
  }
  const dt = Math.max(0.05, Math.min(1, (now - previous.t) / 1000));
  const maxStep = 0.55 * dt;
  const dx = target.x - previous.x;
  const dy = target.y - previous.y;
  const distance = Math.hypot(dx, dy);
  const limited = distance > maxStep ? maxStep / distance : 1;
  const alpha = 0.35;
  const next = {
    x: previous.x + dx * limited * alpha,
    y: previous.y + dy * limited * alpha,
    t: now,
  };
  positionState.smoothed = next;
  positionState.trail.push(next);
  const cutoff = now - 10_000;
  positionState.trail = positionState.trail.filter((item) => item.t >= cutoff).slice(-90);
  return next;
}

function renderTrail(layer, current) {
  const trail = layer.querySelector('.trained-position-trail');
  if (!trail) return;
  const now = Date.now();
  trail.innerHTML = positionState.trail
    .map((point) => {
      const age = Math.max(0, Math.min(1, (now - point.t) / 10_000));
      const opacity = (0.45 * (1 - age)).toFixed(3);
      const cx = ((point.x - current.x) * 776).toFixed(1);
      const cy = ((point.y - current.y) * 486).toFixed(1);
      return `<circle class="trained-position-trail-dot" cx="${cx}" cy="${cy}" r="5" opacity="${opacity}"></circle>`;
    })
    .join('');
}

function percent(value) {
  return `${Math.round(clamp(value) * 100)}%`;
}

function meters(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed.toFixed(2)} m` : 'n/a';
}

function injectPositionStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .position-capture-form { display: grid; gap: 14px; padding: 16px; margin-bottom: 14px; border: 1px solid rgba(110, 231, 183, .18); border-radius: 12px; background: rgba(4, 20, 24, .58); }
    .position-form-copy { display: grid; gap: 4px; }
    .position-form-copy small { color: var(--muted, #8ca3aa); }
    .position-field-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .position-field-grid label { display: grid; gap: 6px; color: var(--muted, #8ca3aa); font-size: 12px; }
    .position-field-grid input, .position-field-grid select { width: 100%; box-sizing: border-box; border: 1px solid rgba(148, 163, 184, .2); border-radius: 8px; padding: 9px 10px; background: rgba(3, 12, 17, .9); color: #e5f6f3; }
    .position-button-row { display: flex; flex-wrap: wrap; gap: 8px; }
    .position-summary-card { min-width: 190px; }
    .position-mini-metrics { display: flex; gap: 12px; margin-top: 8px; color: var(--muted, #8ca3aa); font-size: 11px; }
    .position-mini-metrics b { color: #d7fff4; }
    .position-model-active .rf-regions { display: none; }
    #trainedPositionLayer[hidden] { display: none; }
    .trained-position-halo { fill: rgba(45, 212, 191, .12); stroke: rgba(94, 234, 212, .25); stroke-width: 2; filter: url(#presenceGlow); }
    .trained-position-core { fill: rgba(45, 212, 191, .82); stroke: #ccfbf1; stroke-width: 2; }
    .trained-position-trail-dot { fill: rgba(94, 234, 212, .75); pointer-events: none; }
    .trained-position-label { fill: #041414; font-size: 13px; font-weight: 800; text-transform: uppercase; pointer-events: none; }
    @media (max-width: 900px) { .position-field-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 560px) { .position-field-grid { grid-template-columns: 1fr; } }
  `;
  document.head.append(style);
}
