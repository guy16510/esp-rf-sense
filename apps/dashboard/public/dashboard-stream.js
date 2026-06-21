const listeners = new Map();
const state = {
  source: null,
  connected: false,
  opens: 0,
  closes: 0,
  parseErrors: 0,
  sequence: 0,
  lastEventAt: 0,
  latestSnapshot: null,
  latestRecording: null,
  latestModel: null,
  lastPosition: null,
  lastPositionAt: 0,
};

const BAR_ZONE_NEIGHBORS = {
  'near-left': ['near-center', 'far-left'],
  'near-center': ['near-left', 'near-right', 'far-center'],
  'near-right': ['near-center', 'far-right'],
  'far-left': ['near-left', 'far-center'],
  'far-center': ['far-left', 'far-right', 'near-center'],
  'far-right': ['far-center', 'near-right'],
};

function on(type, handler) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(handler);
  return () => listeners.get(type)?.delete(handler);
}

function emit(type, value) {
  for (const handler of listeners.get(type) || []) handler(value);
}

function parse(event, type) {
  try {
    const value = JSON.parse(event.data);
    state.lastEventAt = Date.now();
    if (type === 'snapshot' || type === 'nodes') {
      const sequence = Number(value.sequence ?? state.sequence + 1);
      if (!Number.isFinite(sequence) || sequence <= state.sequence) return;
      state.sequence = sequence;
      guardCoarseTransition(value);
      state.latestSnapshot = value;
      emit('snapshot', value);
      emit('nodes', value);
      emit('state', value.fused || {});
      return;
    }
    if (type === 'recording') state.latestRecording = value;
    if (type === 'model') state.latestModel = value;
    emit(type, value);
  } catch (error) {
    state.parseErrors++;
    emit('error', error);
  }
}

function guardCoarseTransition(snapshot) {
  const fused = snapshot?.fused;
  const position = fused?.position;
  const coarse = fused?.modelTarget === 'coarse-zones' || fused?.modelTarget === 'position';
  if (!coarse || !position?.accepted || !position.zone) {
    if (fused?.state === 'clear') {
      state.lastPosition = null;
      state.lastPositionAt = 0;
    }
    return;
  }
  const now = Date.now();
  const previous = state.lastPosition;
  if (
    previous?.zone &&
    previous.zone !== position.zone &&
    now - state.lastPositionAt < 1200 &&
    Number(position.confidence || 0) < 0.9 &&
    !(BAR_ZONE_NEIGHBORS[previous.zone] || []).includes(position.zone)
  ) {
    fused.position = {
      ...previous,
      reason: `held previous zone; rejected implausible jump to ${position.zone}`,
    };
    fused.zone = previous.zone;
    fused.bubbles = Array.isArray(fused.bubbles)
      ? fused.bubbles.map((bubble) => ({ ...bubble, x: previous.x, y: previous.y, zone: previous.zone }))
      : [];
    return;
  }
  state.lastPosition = { ...position };
  state.lastPositionAt = now;
}

function start() {
  if (state.source) return state.source;
  const source = new EventSource('/events');
  state.source = source;
  source.onopen = () => {
    state.connected = true;
    state.opens++;
    emit('open', { ...state });
  };
  source.addEventListener('snapshot', (event) => parse(event, 'snapshot'));
  source.addEventListener('nodes', (event) => {
    if (!state.latestSnapshot) parse(event, 'nodes');
  });
  for (const type of ['recording', 'model', 'device']) {
    source.addEventListener(type, (event) => parse(event, type));
  }
  source.onerror = () => {
    state.connected = false;
    state.closes++;
    emit('close', { ...state });
  };
  return source;
}

async function trainModel(body) {
  const response = await fetch('/api/model/train', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || response.statusText);
  return value;
}

async function trainPositionWithFallback(continuousRequest) {
  try {
    return await trainModel(continuousRequest);
  } catch (continuousError) {
    try {
      const model = await trainModel({
        target: 'position',
        window: 64,
        step: 32,
        minRecordingsPerClass: 1,
      });
      return {
        ...model,
        fallback: 'coarse-zones',
        continuousError: continuousError instanceof Error ? continuousError.message : String(continuousError),
      };
    } catch (coarseError) {
      throw new Error(
        `Continuous XY failed: ${continuousError instanceof Error ? continuousError.message : String(continuousError)}. Coarse fallback failed: ${coarseError instanceof Error ? coarseError.message : String(coarseError)}`,
      );
    }
  }
}

function roomMeters(field) {
  try {
    const config = JSON.parse(localStorage.getItem('rfsense-room-setup/v1') || '{}') || {};
    return Math.max(0.001, Number(config[field] || 0) * 0.3048);
  } catch {
    return 0.001;
  }
}

function receiverMappings() {
  const snapshot = state.latestSnapshot || {};
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const ids = Array.isArray(snapshot.slotDeviceIds) ? snapshot.slotDeviceIds : [];
  return Object.fromEntries(
    ['A', 'B', 'C', 'D'].map((slot, index) => {
      const deviceId = ids[index] || nodes[index]?.deviceId;
      return [slot, { deviceId: String(deviceId || '').replace(/^0x/iu, '').padStart(8, '0') }];
    }),
  );
}

function installTrainingFallback() {
  const button = document.getElementById('trainModelButton');
  if (!button) return;
  button.addEventListener(
    'click',
    async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const loadButton = document.getElementById('loadModelButton');
      const status = document.getElementById('modelStatus');
      const badge = document.getElementById('modelBadge');
      button.disabled = true;
      if (loadButton) loadButton.disabled = true;
      if (status) status.textContent = 'Training continuous XY model from synchronized recordings...';
      try {
        const model = await trainPositionWithFallback({
          target: 'continuous-xy',
          roomWidthMeters: roomMeters('widthFeet'),
          roomHeightMeters: roomMeters('lengthFeet'),
          sourceMappings: receiverMappings(),
          windowPackets: 24,
          stepPackets: 8,
        });
        state.latestModel = model;
        if (model.fallback === 'coarse-zones') {
          if (status) {
            status.textContent = `Loaded coarse XY fallback from ${model.recordings || 0} recordings and ${model.windows || 0} windows. This shows trained zone coordinates while RFV2 continuous XY remains unavailable.`;
          }
          if (badge) {
            badge.className = 'badge ready';
            badge.textContent = 'Coarse XY fallback';
          }
        } else {
          if (status) {
            status.textContent = `Loaded continuous XY model from ${model.recordings || 0} recordings and ${model.windows || 0} windows.`;
          }
          if (badge) {
            badge.className = 'badge ready';
            badge.textContent = 'Continuous XY loaded';
          }
        }
        renderDashboardGuidance();
      } catch (error) {
        if (status) status.textContent = error instanceof Error ? error.message : String(error);
        if (badge) {
          badge.className = 'badge issue';
          badge.textContent = 'Training failed';
        }
        renderDashboardGuidance();
      } finally {
        button.disabled = false;
        if (loadButton) loadButton.disabled = false;
      }
    },
    true,
  );
}

function installDashboardGuidance() {
  if (!document.querySelector('.overview-grid')) {
    window.setTimeout(installDashboardGuidance, 50);
    return;
  }
  injectDashboardGuidanceStyles();
  ensureDashboardGuidanceDom();
  on('snapshot', () => renderDashboardGuidance());
  on('model', (model) => {
    state.latestModel = model;
    renderDashboardGuidance();
  });
  on('recording', (recording) => {
    state.latestRecording = recording;
    renderDashboardGuidance();
  });
  void readJson('/api/model').then((model) => {
    if (model) state.latestModel = model;
    renderDashboardGuidance();
  });
  void readJson('/api/recording').then((recording) => {
    if (recording) state.latestRecording = recording;
    renderDashboardGuidance();
  });
  renderDashboardGuidance();
}

function ensureDashboardGuidanceDom() {
  const overview = document.querySelector('.overview-grid');
  if (overview && !document.getElementById('setupGuidanceCard')) {
    const card = document.createElement('article');
    card.id = 'setupGuidanceCard';
    card.className = 'summary-card setup-guidance-card';
    card.innerHTML = `
      <span>Next action</span>
      <strong id="setupNextAction">Inspecting setup</strong>
      <small id="setupNextDetail">Waiting for room and receiver state.</small>
      <div id="setupHealthChecklist" class="setup-health-checklist" aria-label="Setup health gates"></div>
    `;
    overview.prepend(card);
  }

  const operations = document.querySelector('.operations-grid');
  if (operations && !document.getElementById('calibrationCoveragePanel')) {
    const panel = document.createElement('article');
    panel.id = 'calibrationCoveragePanel';
    panel.className = 'panel operations-panel calibration-coverage-panel';
    panel.innerHTML = `
      <div class="panel-heading"><div><span class="eyebrow">ONBOARDING</span><h2>Calibration coverage and trust gates</h2></div><span id="trustGateBadge" class="badge neutral">Waiting</span></div>
      <div class="operation-body">
        <div id="whyNoDot" class="why-no-dot">No dot because the dashboard is still loading receiver state.</div>
        <div id="receiverGeometrySummary" class="receiver-geometry-summary">Receiver geometry is waiting for node state.</div>
        <div id="calibrationCoverageGrid" class="calibration-coverage-grid" aria-label="Calibration coverage map"></div>
        <div id="modelQualitySummary" class="model-quality-summary"></div>
      </div>
    `;
    operations.append(panel);
  }
}

function renderDashboardGuidance() {
  ensureDashboardGuidanceDom();
  const snapshot = state.latestSnapshot;
  const model = state.latestModel;
  const config = roomSetupConfig();
  const readiness = snapshot?.readiness || {};
  const fused = snapshot?.fused || {};
  const next = nextDashboardAction(config, snapshot, model);

  setText('setupNextAction', next.title);
  setText('setupNextDetail', next.detail);
  setText('whyNoDot', whyNoDotMessage(config, snapshot, model));
  renderSetupHealthChecklist(config, snapshot, model);
  renderCalibrationCoverage(config);
  renderModelQuality(model, fused);
  renderReceiverGeometry(snapshot, config);
}

function roomSetupConfig() {
  const fallback = {
    version: 1,
    configured: false,
    widthFeet: 0,
    lengthFeet: 0,
    emptyRecordings: 0,
    zones: [],
    complete: false,
  };
  try {
    const parsed = JSON.parse(localStorage.getItem('rfsense-room-setup/v1') || 'null');
    if (!parsed || parsed.version !== 1) return fallback;
    return {
      ...fallback,
      ...parsed,
      configured: true,
      zones: Array.isArray(parsed.zones) ? parsed.zones : [],
      widthFeet: Number(parsed.widthFeet || 0),
      lengthFeet: Number(parsed.lengthFeet || 0),
      emptyRecordings: Number(parsed.emptyRecordings || 0),
    };
  } catch {
    return fallback;
  }
}

function nextDashboardAction(config, snapshot, model) {
  const ready = Boolean(snapshot?.readiness?.readyForCapture);
  const position = snapshot?.fused?.position;
  if (!snapshot) return { title: 'Connect receivers first', detail: 'Waiting for the collector to publish four receiver streams.' };
  if (!config.configured) return { title: 'Set up room', detail: 'Open the room setup guide so dimensions, receiver slots, and training points are saved.' };
  if (!roomIsValid(config)) return { title: 'Fix room definition', detail: 'Room name, width, length, person ID, and unique zone labels are required before recording.' };
  if (!ready) return { title: 'Fix receiver health', detail: (snapshot.readiness?.reasons || ['All four receivers must be fresh, calibrated, and streaming CSI.']).join(' ') };
  if (config.emptyRecordings < 2) return { title: 'Record empty room', detail: `${config.emptyRecordings} of 2 empty-room captures are saved.` };
  const missing = missingTrainingZones(config);
  if (missing.length) return { title: 'Record calibration grid', detail: `Missing stationary captures for ${missing.join(', ')}.` };
  if (!model?.loaded) return { title: 'Train model', detail: 'Coverage exists, now train and load the grouped position model.' };
  if (snapshot.fused?.state !== 'clear' && !position?.accepted) return { title: 'Fix rejected position', detail: whyNoDotMessage(config, snapshot, model) };
  return { title: 'Run live validation', detail: 'Walk the trained points and confirm the marker only appears when confidence and overlap pass.' };
}

function renderSetupHealthChecklist(config, snapshot, model) {
  const items = [
    ['Room', config.configured && roomIsValid(config)],
    ['4 receivers', Boolean(snapshot?.readiness?.readyForCapture)],
    ['Empty', config.emptyRecordings >= 2],
    ['Zones', config.zones.length > 0 && missingTrainingZones(config).length === 0],
    ['Model', Boolean(model?.loaded)],
  ];
  const element = document.getElementById('setupHealthChecklist');
  if (!element) return;
  element.innerHTML = items.map(([label, passed]) => `<span class="${passed ? 'passed' : ''}">${passed ? '✓' : '!'} ${escapeHtml(label)}</span>`).join('');
}

function renderCalibrationCoverage(config) {
  const grid = document.getElementById('calibrationCoverageGrid');
  if (!grid) return;
  const zones = config.zones.length ? config.zones : defaultCoverageZones();
  grid.innerHTML = zones.map((zone) => {
    const stationary = Number(zone.stationary || 0);
    const moving = Number(zone.moving || 0);
    const complete = stationary > 0;
    const label = zone.label || zone.id || 'zone';
    return `<article class="calibration-coverage-cell ${complete ? 'complete' : ''}" data-zone="${escapeHtml(label)}"><strong>${escapeHtml(label)}</strong><small>${stationary} still, ${moving} moving</small><span>${complete ? 'covered' : 'missing'}</span></article>`;
  }).join('');
}

function renderModelQuality(model, fused) {
  const badge = document.getElementById('trustGateBadge');
  const summary = document.getElementById('modelQualitySummary');
  if (!summary || !badge) return;
  const position = fused?.position || {};
  const confidence = Number(position.confidence ?? model?.confidence ?? 0);
  const overlap = Number(position.packetOverlap ?? position.agreement ?? model?.packetOverlap ?? 0);
  const loaded = Boolean(model?.loaded);
  const validation = model?.validation || model?.metrics || {};
  const median = validation.medianErrorMeters ?? validation.medianError ?? model?.medianErrorMeters;
  const p90 = validation.p90ErrorMeters ?? validation.p90Error ?? model?.p90ErrorMeters;
  const rejectionRate = validation.rejectionRate ?? model?.rejectionRate;
  const pass = loaded && (fused?.state === 'clear' || position.accepted || confidence >= 0.65 || overlap >= 0.6);
  badge.className = `badge ${pass ? 'ready' : loaded ? 'issue' : 'neutral'}`;
  badge.textContent = pass ? 'Trust gates visible' : loaded ? 'Needs validation' : 'No model';
  summary.innerHTML = `
    <strong>Validation gates</strong>
    <div class="model-quality-grid">
      <span><b>${loaded ? model.target || 'loaded' : 'not loaded'}</b> model</span>
      <span><b>${percent(confidence)}</b> confidence</span>
      <span><b>${percent(overlap)}</b> overlap</span>
      <span><b>${formatMeters(median)}</b> median error</span>
      <span><b>${formatMeters(p90)}</b> p90 error</span>
      <span><b>${rejectionRate == null ? 'n/a' : percent(rejectionRate)}</b> rejected</span>
    </div>
  `;
}

function renderReceiverGeometry(snapshot, config) {
  const svg = document.querySelector('#roomD3');
  const summary = document.getElementById('receiverGeometrySummary');
  if (!svg) return;
  let layer = svg.querySelector('#receiverGeometryLayer');
  if (!layer) {
    layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.id = 'receiverGeometryLayer';
    svg.prepend(layer);
  }
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes.slice(0, 4) : [];
  const points = [
    ['A', 0.02, 0.02],
    ['B', 0.98, 0.02],
    ['C', 0.02, 0.98],
    ['D', 0.98, 0.98],
  ];
  layer.innerHTML = points.map(([slot, xNorm, yNorm], index) => {
    const node = nodes[index];
    const x = 62 + xNorm * 776;
    const y = 62 + yNorm * 486;
    const ready = Boolean(node?.ready);
    return `<g class="receiver-geometry-node ${ready ? 'ready' : ''}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})"><circle r="17"></circle><text text-anchor="middle" dy="5">${slot}</text><title>Receiver ${slot}: ${ready ? 'ready' : 'needs attention'}</title></g>`;
  }).join('');
  if (summary) {
    const readyCount = nodes.filter((node) => node?.ready).length;
    const geometryCopy = config.configured ? `${Number(config.widthFeet || 0).toFixed(1)} ft × ${Number(config.lengthFeet || 0).toFixed(1)} ft room` : 'room geometry not saved';
    summary.textContent = `${readyCount} / 4 receiver slots ready, ${geometryCopy}.`;
  }
}

function whyNoDotMessage(config, snapshot, model) {
  const fused = snapshot?.fused || {};
  const position = fused.position || {};
  if (!snapshot) return 'No dot because no receiver snapshot has arrived yet.';
  if (fused.state === 'clear') return 'No dot because the room is currently clear.';
  if (!config.configured) return 'No dot because room setup has not been completed.';
  if (!model?.loaded && !fused.modelTarget) return 'No dot because a position model is not loaded.';
  if (position.accepted) return 'Dot is visible, keep validating confidence, overlap, and movement behavior.';
  if (position.reason) return `No dot because ${position.reason}.`;
  const confidence = Number(position.confidence || 0);
  const overlap = Number(position.packetOverlap ?? position.agreement ?? 0);
  const receiverCount = Number(position.receiverCount || position.contributors || 0);
  if (receiverCount > 0 && receiverCount < 4) return `No dot because only ${receiverCount} of 4 receivers contributed.`;
  if (confidence > 0 && confidence < 0.65) return `No dot because confidence is ${percent(confidence)}, below the acceptance gate.`;
  if (overlap > 0 && overlap < 0.6) return `No dot because packet overlap is ${percent(overlap)}, below the acceptance gate.`;
  return 'No dot because the trained model has not produced an accepted position estimate yet.';
}

function roomIsValid(config) {
  const labels = config.zones.map((zone) => zone.label).filter(Boolean);
  return Boolean(config.configured && config.widthFeet > 0 && config.lengthFeet > 0 && labels.length >= 2 && new Set(labels).size === labels.length);
}

function missingTrainingZones(config) {
  return config.zones.filter((zone) => Number(zone.stationary || 0) < 1).map((zone) => zone.label || zone.id || 'zone');
}

function defaultCoverageZones() {
  return [
    { label: 'near-left' },
    { label: 'near-center' },
    { label: 'near-right' },
    { label: 'far-left' },
    { label: 'far-center' },
    { label: 'far-right' },
  ];
}

function injectDashboardGuidanceStyles() {
  if (document.getElementById('dashboardGuidanceStyles')) return;
  const style = document.createElement('style');
  style.id = 'dashboardGuidanceStyles';
  style.textContent = `
    .setup-guidance-card { border-color: rgba(45, 212, 191, .28); background: rgba(13, 148, 136, .08); }
    .setup-health-checklist { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .setup-health-checklist span { padding: 4px 7px; border: 1px solid rgba(248, 113, 113, .22); border-radius: 999px; color: #fca5a5; font-size: 11px; font-weight: 800; }
    .setup-health-checklist span.passed { border-color: rgba(74, 222, 128, .24); color: #86efac; }
    .calibration-coverage-panel .operation-body { display: grid; gap: 14px; }
    .why-no-dot, .receiver-geometry-summary, .model-quality-summary { padding: 12px 14px; border: 1px solid rgba(148, 163, 184, .14); border-radius: 11px; background: rgba(3, 12, 17, .55); color: #cbd5e1; }
    .why-no-dot { border-color: rgba(251, 191, 36, .22); color: #fde68a; }
    .calibration-coverage-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .calibration-coverage-cell { display: grid; gap: 3px; padding: 10px; border: 1px solid rgba(248, 113, 113, .2); border-radius: 10px; background: rgba(127, 29, 29, .08); }
    .calibration-coverage-cell.complete { border-color: rgba(74, 222, 128, .24); background: rgba(22, 163, 74, .08); }
    .calibration-coverage-cell strong { color: #e5f6f3; }
    .calibration-coverage-cell small, .calibration-coverage-cell span { color: #8ca3aa; font-size: 11px; }
    .model-quality-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 8px; }
    .model-quality-grid span { display: grid; gap: 2px; color: #8ca3aa; font-size: 11px; }
    .model-quality-grid b { color: #d7fff4; font-size: 13px; }
    #receiverGeometryLayer .receiver-geometry-node circle { fill: rgba(251, 191, 36, .14); stroke: rgba(251, 191, 36, .82); stroke-width: 2; }
    #receiverGeometryLayer .receiver-geometry-node.ready circle { fill: rgba(45, 212, 191, .16); stroke: #2dd4bf; }
    #receiverGeometryLayer .receiver-geometry-node text { fill: #ecfeff; font-size: 13px; font-weight: 900; pointer-events: none; }
    @media (max-width: 760px) { .calibration-coverage-grid, .model-quality-grid { grid-template-columns: 1fr; } }
  `;
  document.head.append(style);
}

async function readJson(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function setText(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function percent(value) {
  const parsed = Number(value);
  return `${Math.round((Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0) * 100)}%`;
}

function formatMeters(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed.toFixed(2)} m` : 'n/a';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

window.RfSenseDashboardStream = {
  on,
  start,
  state,
  trainPositionWithFallback,
  guardCoarseTransition,
};

installTrainingFallback();
installDashboardGuidance();
start();