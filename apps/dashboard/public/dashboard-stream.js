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

window.RfSenseDashboardStream = {
  on,
  start,
  state,
  trainPositionWithFallback,
};

start();
