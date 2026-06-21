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
      } catch (error) {
        if (status) status.textContent = error instanceof Error ? error.message : String(error);
        if (badge) {
          badge.className = 'badge issue';
          badge.textContent = 'Training failed';
        }
      } finally {
        button.disabled = false;
        if (loadButton) loadButton.disabled = false;
      }
    },
    true,
  );
}

window.RfSenseDashboardStream = {
  on,
  start,
  state,
  trainPositionWithFallback,
  guardCoarseTransition,
};

installTrainingFallback();
start();
