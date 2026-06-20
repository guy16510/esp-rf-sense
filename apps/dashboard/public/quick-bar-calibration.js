const STEPS = [
  { label: 'empty', empty: true },
  { label: 'near-left', x: 0.18, y: 0.30 },
  { label: 'near-center', x: 0.50, y: 0.30 },
  { label: 'near-right', x: 0.82, y: 0.30 },
  { label: 'far-left', x: 0.18, y: 0.72 },
  { label: 'far-center', x: 0.50, y: 0.72 },
  { label: 'far-right', x: 0.82, y: 0.72 },
];

const state = {
  step: 0,
  running: false,
  waitingForStop: false,
};

setTimeout(init, 0);

function init() {
  const form = document.getElementById('positionCaptureForm');
  if (!form || document.getElementById('quickBarCalibration')) {
    if (!form) setTimeout(init, 100);
    return;
  }

  const panel = document.createElement('section');
  panel.id = 'quickBarCalibration';
  panel.className = 'quick-bar-calibration';
  panel.innerHTML = `
    <div>
      <strong>Fast bar calibration</strong>
      <small>One empty baseline plus a 3 × 2 customer-area grid. No tape measure required.</small>
    </div>
    <div class="quick-bar-progress"><span id="quickBarStep">Ready</span><progress id="quickBarProgress" max="7" value="0"></progress></div>
    <button id="quickBarAction" type="button">Start two-minute bar calibration</button>
    <p id="quickBarHint" class="muted">Each capture lasts about 15 seconds. Move to the prompted position, face the taps, and press the button.</p>
  `;
  form.prepend(panel);
  document.getElementById('quickBarAction').addEventListener('click', () => void captureCurrentStep());
  window.RfSenseDashboardStream?.on('recording', handleRecording);
  injectStyles();
}

async function captureCurrentStep() {
  const snapshot = window.RfSenseDashboardStream?.state?.latestSnapshot;
  if (!snapshot?.readiness?.readyForCapture) {
    return setHint('All four receivers must be healthy before quick calibration starts.');
  }
  if (state.waitingForStop) return;

  if (!state.running) {
    state.running = true;
    state.step = 0;
  }

  const step = STEPS[state.step];
  if (!step) return;
  const subjectId = String(document.getElementById('positionSubject')?.value || 'person-1').trim();
  const day = String(document.getElementById('positionDay')?.value || new Date().toISOString().slice(0, 10));
  const metadata = step.empty
    ? {
        label: 'empty',
        target: 'position',
        recordingId: `quick-bar-empty-${Date.now()}`,
        day,
        movement: 'empty',
      }
    : {
        label: `occupied-${step.label}`,
        target: 'position',
        recordingId: `quick-bar-${step.label}-${Date.now()}`,
        subjectId,
        day,
        movement: 'stationary',
        position: { label: step.label, x: step.x, y: step.y },
      };

  disableAction(true);
  setHint(step.empty ? 'Keep the bar area empty.' : `Stand at ${step.label}, face the taps, and remain mostly still.`);
  try {
    state.waitingForStop = true;
    await post('/api/recording/start', {
      label: encodeMetadata(metadata),
      targetSeconds: 15,
      targetFrames: 300,
    });
    updateProgress(`Recording ${state.step + 1} of ${STEPS.length}: ${step.label}`);
  } catch (error) {
    state.waitingForStop = false;
    disableAction(false);
    setHint(error instanceof Error ? error.message : String(error));
  }
}

function handleRecording(recording) {
  if (!state.running || !state.waitingForStop) return;
  if (recording?.active) return;
  state.waitingForStop = false;
  state.step += 1;
  updateProgress();
  if (state.step >= STEPS.length) {
    void trainQuickModel();
    return;
  }
  const next = STEPS[state.step];
  const button = document.getElementById('quickBarAction');
  if (button) button.textContent = `Capture ${next.label}`;
  setHint(next.empty ? 'Clear the bar area.' : `Move to ${next.label}, face the taps, then press Capture.`);
  disableAction(false);
}

async function trainQuickModel() {
  disableAction(true);
  setHint('Training the quick bar position model...');
  try {
    const model = await post('/api/model/train', {
      target: 'position',
      window: 48,
      step: 16,
      minRecordingsPerClass: 1,
    });
    const badge = document.getElementById('modelBadge');
    const status = document.getElementById('modelStatus');
    if (badge) {
      badge.className = 'badge ready';
      badge.textContent = 'Quick bar model loaded';
    }
    if (status) {
      status.textContent = `Loaded ${model.classes?.length || 0} bar zones from ${model.recordings || 0} recordings and ${model.windows || 0} windows.`;
    }
    setHint('Calibration complete. Walk through the six zones and confirm the circle follows the correct area.');
    const button = document.getElementById('quickBarAction');
    if (button) button.textContent = 'Run calibration again';
    state.running = false;
    state.step = 0;
    updateProgress('Complete');
  } catch (error) {
    setHint(error instanceof Error ? error.message : String(error));
    const button = document.getElementById('quickBarAction');
    if (button) button.textContent = 'Retry training';
  } finally {
    disableAction(false);
  }
}

function updateProgress(text) {
  const label = document.getElementById('quickBarStep');
  const progress = document.getElementById('quickBarProgress');
  if (label) label.textContent = text || `${Math.min(state.step, STEPS.length)} of ${STEPS.length} captured`;
  if (progress) progress.value = Math.min(state.step, STEPS.length);
}

function disableAction(disabled) {
  const button = document.getElementById('quickBarAction');
  if (button) button.disabled = disabled;
}

function setHint(message) {
  const hint = document.getElementById('quickBarHint');
  if (hint) hint.textContent = message;
}

function encodeMetadata(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `rfsense-meta:${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
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

function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .quick-bar-calibration { display:grid; gap:12px; padding:14px; border:1px solid rgba(45,212,191,.35); border-radius:12px; background:rgba(5,46,45,.35); }
    .quick-bar-calibration > div:first-child { display:grid; gap:4px; }
    .quick-bar-calibration small { color:var(--muted,#8ca3aa); }
    .quick-bar-progress { display:grid; grid-template-columns:auto 1fr; gap:10px; align-items:center; }
    .quick-bar-progress progress { width:100%; }
  `;
  document.head.append(style);
}
