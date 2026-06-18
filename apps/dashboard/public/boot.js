import * as d3 from '/d3.js';
import { RfScene } from '/scene-view.js';
import { LiveTimeline } from '/timeline.js';

const style = document.createElement('link');
style.rel = 'stylesheet';
style.href = '/control-center.css?v=node-stats-2';
document.head.append(style);

const get = (id) => document.getElementById(id);
const percent = (value) => `${Math.round(Number(value || 0) * 100)}%`;
const number = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const text = (value, fallback = '—') =>
  value === undefined || value === null || value === '' ? fallback : String(value);
const scene = new RfScene(get('scene'), get('sceneTooltip'));
const timeline = new LiveTimeline(get('timeline'));
const logLines = [];
let meta;
let latestSignal;
let latestDevice;
let latestRecording;
let latestNodes;
let paused = false;

function installRecordingPanel() {
  const controls = document.querySelector('.device-section.controls');
  if (!controls || get('recordingStatus')) return;
  const section = document.createElement('div');
  section.className = 'device-section recording-controls';
  section.innerHTML = `
    <h3>Training recordings</h3>
    <div class="control-grid recording-grid">
      <button data-recording-label="empty" type="button">Record empty</button>
      <button data-recording-label="occupied-moving" type="button">Record moving</button>
      <button data-recording-label="occupied-stationary" type="button">Record stationary</button>
      <button id="stopRecordingButton" type="button" class="danger">Stop recording</button>
    </div>
    <p id="recordingStatus" class="muted">No recording active. Recordings auto-save after 90s and 2,000 frames.</p>
  `;
  controls.insertAdjacentElement('afterend', section);
}

function adapt(state) {
  return {
    ...state,
    ts: state.timestamp,
    scene: {
      audience: {
        estimate: state.state === 'active' ? 1 : 0,
        min: 0,
        max: state.state === 'active' ? 1 : 0,
        confidence: state.confidence,
      },
      zone: state.zone,
      directionKnown: false,
      entities: [],
      caveat: meta?.disclaimer || 'Anonymous aggregate RF activity.',
    },
  };
}

function renderSignal(raw) {
  latestSignal = raw;
  if (paused) return;
  const age = raw.ageSec;
  const stale = Number.isFinite(age) && age > 3;
  const state = stale ? 'stale' : raw.state;
  const label =
    {
      waiting: 'Waiting',
      baseline: 'Learning',
      clear: 'Clear',
      active: 'Activity',
      stale: 'Stale',
    }[state] || state;

  get('streamDot').className =
    state === 'clear' || state === 'active' ? 'live' : state === 'stale' ? 'stale' : '';
  get('streamStatus').textContent = state === 'stale' ? `Stale ${age.toFixed(1)}s` : label;
  get('stateValue').textContent = label;
  get('stateDetail').textContent = signalDetail(state);
  get('confidenceValue').textContent = percent(raw.confidence);
  get('confidenceBar').firstElementChild.style.width = percent(raw.confidence);
  get('motionValue').textContent = number(raw.motion).toFixed(4);
  get('frameRateValue').textContent = `${number(raw.frameRateHz).toFixed(1)} Hz`;
  get('frameDetail').textContent = `${number(raw.datagrams).toLocaleString()} datagrams`;
  get('streamAgeValue').textContent = Number.isFinite(age) ? `${age.toFixed(2)}s` : '—';
  get('qualityDetail').textContent = stale
    ? 'CSI stream stopped updating'
    : `${number(raw.invalidDatagrams)} invalid datagrams`;
  get('subcarrierValue').textContent = `${raw.amplitudeProfile?.length || 0} subcarriers`;
  get('modeValue').textContent = raw.mode;
  get('datagramValue').textContent = number(raw.datagrams).toLocaleString();
  get('invalidValue').textContent = number(raw.invalidDatagrams).toLocaleString();
  get('lossValue').textContent = `${number(raw.lossPpm)} ppm`;

  const diagnostics = raw.diagnostics || {};
  const progress = number(diagnostics.baselineProgress);
  get('baselineProgress').style.width = percent(progress);
  get('baselineValue').textContent = diagnostics.baselineReady
    ? `Baseline ${formatSmall(diagnostics.baselineMean)}`
    : `${number(diagnostics.baselineSamples)}/${number(diagnostics.baselineRequired)} samples`;
  get('baselineLabel').textContent = diagnostics.baselineReady
    ? 'Empty-room baseline learned. Relearn after moving the router or ESP32.'
    : 'Keep the RF path empty and still while the baseline is learned.';
  get('baselineMeanValue').textContent = formatSmall(diagnostics.baselineMean);
  get('baselineDeviationValue').textContent = formatSmall(diagnostics.baselineDeviation);
  get('activationValue').textContent = percent(diagnostics.activationScore);

  renderProfile(raw.amplitudeProfile || []);
  scene.update({
    active: state === 'active',
    state,
    confidence: raw.confidence,
    motion: raw.motion,
    zone: raw.zone,
  });
  timeline.add(adapt(raw));
  updateDiagnosis();
}

function signalDetail(state) {
  if (state === 'waiting') return 'No CSI frames have reached the dashboard';
  if (state === 'baseline') return 'Learning quiet RF conditions';
  if (state === 'active') return 'Anonymous RF channel disturbance detected';
  if (state === 'stale') return 'Previously received CSI, but the stream is now stale';
  return 'No significant moving disturbance detected';
}

function renderDevice(device) {
  latestDevice = device;
  const status = device?.status || {};
  const health = device?.health || {};
  const config = device?.config || {};
  const firmware = status.firmware || {};
  const connected = Boolean(device?.connected);

  get('deviceDot').className = connected ? 'live' : '';
  get('deviceStatus').textContent = connected ? 'Device online' : device?.error || 'Device offline';
  get('deviceNameValue').textContent = connected ? text(status.deviceName, 'Online') : 'Offline';
  get('firmwareValue').textContent = connected
    ? `Firmware ${text(firmware.version, 'unknown')}`
    : text(device?.error, 'No telemetry');
  get('identityDevice').textContent = text(status.deviceName || status.deviceId);
  get('identityFirmware').textContent = text(firmware.version);
  get('identityCommit').textContent = text(firmware.gitCommit).slice(0, 10);
  get('uptimeValue').textContent = duration(health.uptimeSeconds);
  get('rssiValue').textContent =
    health.currentRssi === undefined ? '—' : `${health.currentRssi} dBm`;
  get('reconnectValue').textContent = text(health.wifiReconnectCount);
  get('minHeapValue').textContent = bytes(health.minFreeHeap);
  get('watchdogValue').textContent = text(health.watchdogEvents);
  get('bootReasonValue').textContent = text(health.bootReason || health.resetReason);

  renderMemory('heapValue', 'heapMeter', health.freeHeap, health.totalHeap);
  renderMemory('psramValue', 'psramMeter', health.psramFree, health.psramTotal);
  get('cpuValue').textContent = cpuText(health);

  const capture = status.capture || {};
  get('captureValue').textContent = capture.active ? 'Active' : 'Stopped';
  get('capturedValue').textContent = number(health.csiFramesCaptured).toLocaleString();
  get('queueValue').textContent = number(health.csiFramesQueued).toLocaleString();
  get('dropValue').textContent = number(
    health.csiQueueDrops + health.networkQueueDrops,
  ).toLocaleString();
  get('batchValue').textContent = number(health.networkBatchesSent).toLocaleString();
  get('sendFailureValue').textContent = number(health.networkSendFailures).toLocaleString();
  get('collectorValue').textContent = config.collectorHost
    ? `${config.collectorHost}:${config.collectorPort}`
    : '—';
  get('pingValue').textContent =
    `${number(health.pingReplies).toLocaleString()} / ${number(health.pingRequests).toLocaleString()}`;
  get('otaValue').textContent = text(status.ota?.state);

  const level = healthLevel(device);
  const badge = get('healthBadge');
  badge.className = `health-badge ${level}`;
  badge.textContent = level;
  document.querySelectorAll('[data-control]').forEach((button) => {
    button.disabled = !connected;
  });
  updateDiagnosis();
}

function renderRecording(recording) {
  latestRecording = recording;
  const status = get('recordingStatus');
  if (!status) return;
  if (recording?.active) {
    status.textContent =
      `Recording ${recording.label}: ${number(recording.elapsedSeconds).toFixed(0)}s / ${number(recording.targetSeconds)}s, ` +
      `${number(recording.frames).toLocaleString()} / ${number(recording.targetFrames).toLocaleString()} frames, ` +
      `${percent(recording.progress)}. Auto-saves when complete.`;
  } else if (recording?.name) {
    status.textContent = `Saved ${recording.name}: ${number(recording.datagrams).toLocaleString()} datagrams, ${number(recording.frames).toLocaleString()} frames`;
  } else {
    status.textContent =
      recording?.error || 'No recording active. Recordings auto-save after 90s and 2,000 frames.';
  }
  document.querySelectorAll('[data-recording-label]').forEach((button) => {
    button.disabled = Boolean(recording?.active);
  });
  const stop = get('stopRecordingButton');
  if (stop) stop.disabled = !recording?.active;
}

function renderNodes(snapshot) {
  latestNodes = snapshot;
  const root = get('nodeStats');
  const summary = get('nodeSummary');
  if (!root || !summary) return;
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const readiness = snapshot?.readiness || {};
  summary.textContent = nodes.length
    ? `${number(readiness.onlineNodeCount, nodes.filter((node) => node.ready).length)} / ${number(readiness.requiredNodeCount, nodes.length)} ready`
    : 'No nodes discovered';
  root.replaceChildren();
  if (nodes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'node-empty';
    empty.textContent = 'No per-node stream stats are available from this dashboard mode.';
    root.append(empty);
    return;
  }

  for (const [index, node] of nodes.entries()) {
    const age = node.ageSec;
    const stale = Number.isFinite(age) && age > 3;
    const level = stale ? 'stale' : node.ready ? 'ready' : 'warn';
    const diagnostics = node.diagnostics || {};
    const reasons = Array.isArray(node.readinessReasons) ? node.readinessReasons : [];
    const card = document.createElement('article');
    card.className = `node-card ${level}`;
    card.innerHTML = `
      <header>
        <div><h3>Node ${index + 1}</h3><span class="node-id">${text(node.deviceId)}</span></div>
        <span class="node-badge">${stale ? 'stale' : node.ready ? 'ready' : node.state || 'waiting'}</span>
      </header>
      <div class="node-primary">
        <div><span>State</span><strong>${text(node.state)}</strong></div>
        <div><span>Rate</span><strong>${number(node.frameRateHz).toFixed(1)} Hz</strong></div>
        <div><span>Age</span><strong>${Number.isFinite(age) ? `${age.toFixed(2)}s` : '—'}</strong></div>
      </div>
      <div class="node-section">
        <h4>Signal</h4>
        <div class="node-stats">
          <div><span>Confidence</span><strong>${percent(node.confidence)}</strong></div>
          <div><span>Motion</span><strong>${number(node.motion).toFixed(4)}</strong></div>
          <div><span>Baseline</span><strong>${percent(diagnostics.baselineProgress)}</strong></div>
          <div><span>Activation</span><strong>${percent(diagnostics.activationScore)}</strong></div>
        </div>
      </div>
      <div class="node-section">
        <h4>Capture</h4>
        <div class="node-stats">
          <div><span>Datagrams</span><strong>${number(node.datagrams).toLocaleString()}</strong></div>
          <div><span>Frames</span><strong>${number(node.frames).toLocaleString()}</strong></div>
          <div><span>Subcarriers</span><strong>${number(node.subcarrierCount, node.amplitudeProfile?.length || 0).toLocaleString()}</strong></div>
          <div><span>CSI bytes</span><strong>${number(node.csiLength).toLocaleString()}</strong></div>
        </div>
      </div>
      <div class="node-section">
        <h4>Packets</h4>
        <div class="node-stats">
          <div><span>Loss</span><strong>${number(node.lossPpm).toLocaleString()} ppm</strong></div>
          <div><span>Invalid</span><strong>${number(node.invalidDatagrams).toLocaleString()}</strong></div>
          <div><span>Missing</span><strong>${number(node.missingPackets).toLocaleString()}</strong></div>
          <div><span>Duplicate</span><strong>${number(node.duplicatePackets).toLocaleString()}</strong></div>
          <div><span>Out of order</span><strong>${number(node.outOfOrderPackets).toLocaleString()}</strong></div>
        </div>
      </div>
    `;
    if (reasons.length > 0) {
      const reason = document.createElement('p');
      reason.className = 'node-reasons';
      reason.textContent = reasons.join('; ');
      card.append(reason);
    }
    root.append(card);
  }
}

function renderMemory(valueId, meterId, freeRaw, totalRaw) {
  const free = number(freeRaw, NaN);
  const total = number(totalRaw, NaN);
  if (!Number.isFinite(free)) {
    get(valueId).textContent = '—';
    get(meterId).style.width = '0%';
    return;
  }
  get(valueId).textContent =
    Number.isFinite(total) && total > 0
      ? `${bytes(free)} free / ${bytes(total)}`
      : `${bytes(free)} free`;
  const used = Number.isFinite(total) && total > 0 ? Math.max(0, Math.min(1, 1 - free / total)) : 0;
  get(meterId).style.width = percent(used);
}

function healthLevel(device) {
  if (!device?.connected) return 'unknown';
  const health = device.health || {};
  if (number(health.freeHeap) > 0 && number(health.freeHeap) < 50000) return 'critical';
  if (number(health.networkSendFailures) > 0 || number(health.watchdogEvents) > 0) return 'warning';
  return 'healthy';
}

function cpuText(health) {
  if (Number.isFinite(Number(health.cpuUsagePct)))
    return `${number(health.cpuUsagePct).toFixed(1)}%`;
  if (Number.isFinite(Number(health.cpuFrequencyMhz)))
    return `${number(health.cpuFrequencyMhz)} MHz`;
  return 'Unavailable';
}

function updateDiagnosis() {
  const banner = get('diagnosticBanner');
  const hasNodeStats = Array.isArray(latestNodes?.nodes) && latestNodes.nodes.length > 0;
  if (!latestDevice?.connected && (latestSignal?.mode === 'fused' || hasNodeStats)) {
    const datagrams = number(latestSignal?.datagrams);
    const level = datagrams > 0 ? 'good' : 'warn';
    const message =
      datagrams > 0
        ? 'RF stream is live in four-node mode. Device HTTP telemetry/control is not connected, so ESP32 health fields and controls are unavailable.'
        : 'Four-node dashboard is running, but no RF datagrams have arrived yet. Device HTTP telemetry/control is optional for this mode.';
    return setDiagnosis(banner, level, message);
  }
  if (!latestDevice?.connected)
    return setDiagnosis(
      banner,
      'bad',
      'Device HTTP API is offline. Start with --device http://<device-ip> only when you need ESP32 telemetry or controls.',
    );
  const status = latestDevice.status || {};
  const health = latestDevice.health || {};
  if (!status.capture?.active)
    return setDiagnosis(
      banner,
      'warn',
      'Device is online, but capture is stopped. Start capture from the device controls.',
    );
  if (number(health.csiFramesCaptured) === 0)
    return setDiagnosis(
      banner,
      'bad',
      'Capture is active, but the ESP32 has captured no CSI frames. Verify 2.4 GHz Wi-Fi and controlled ping replies.',
    );
  if (number(health.networkBatchesSent) === 0)
    return setDiagnosis(
      banner,
      'bad',
      'CSI is captured, but no UDP batches are being sent. Check the device collector configuration.',
    );
  if (!latestSignal || number(latestSignal.datagrams) === 0)
    return setDiagnosis(
      banner,
      'bad',
      'The ESP32 is sending UDP, but this dashboard receives nothing. Check collector IP, UDP port 5566, and the computer firewall.',
    );
  if (Number.isFinite(latestSignal.ageSec) && latestSignal.ageSec > 3)
    return setDiagnosis(
      banner,
      'warn',
      'The CSI stream is stale. The device may have rebooted or Wi-Fi may have dropped.',
    );
  setDiagnosis(
    banner,
    'good',
    'Device telemetry and live CSI are flowing normally. Walk across the router-to-ESP32 path to test disturbance detection.',
  );
}

function setDiagnosis(element, level, message) {
  element.className = `diagnostic-banner ${level}`;
  element.textContent = message;
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

function renderProfile(values) {
  const svg = d3.select('#profileChart');
  if (!values.length) {
    svg.selectAll('*').remove();
    return;
  }
  const x = d3
    .scaleLinear()
    .domain([0, values.length - 1])
    .range([36, 986]);
  const extent = d3.extent(values);
  const domain = extent[0] === extent[1] ? [extent[0] - 1, extent[1] + 1] : extent;
  const y = d3.scaleLinear().domain(domain).nice().range([198, 14]);
  const line = d3
    .line()
    .x((_, index) => x(index))
    .y((value) => y(value))
    .curve(d3.curveMonotoneX);
  svg
    .selectAll('path.profile')
    .data([values])
    .join('path')
    .attr('class', 'profile')
    .attr('d', line);
}

function renderLog(entry) {
  logLines.push(`[${(entry.uptimeMs / 1000).toFixed(3)}] ${entry.line.trimEnd()}`);
  if (logLines.length > 300) logLines.shift();
  const root = get('deviceLogs');
  root.textContent = logLines.join('\n');
  root.scrollTop = root.scrollHeight;
  get('logStatus').textContent = `Live (${entry.sequence})`;
}

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

async function control(action, button) {
  const destructive = action === 'reboot' || action === 'ota-apply';
  if (destructive && !window.confirm(`Confirm ${action.replace('-', ' ')}?`)) return;
  const buttons = [...document.querySelectorAll('[data-control]')];
  buttons.forEach((item) => {
    item.disabled = true;
  });
  get('controlStatus').textContent = `${button.textContent} in progress...`;
  try {
    const result = await json('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    get('controlStatus').textContent = JSON.stringify(result);
  } catch (error) {
    get('controlStatus').textContent = error.message;
  } finally {
    setTimeout(
      () =>
        buttons.forEach((item) => {
          item.disabled = !latestDevice?.connected;
        }),
      800,
    );
  }
}

async function startRecording(label, button) {
  const buttons = [...document.querySelectorAll('[data-recording-label]')];
  buttons.forEach((item) => {
    item.disabled = true;
  });
  get('recordingStatus').textContent = `${button.textContent} starting...`;
  try {
    const result = await json('/api/recording/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, targetSeconds: 90, targetFrames: 2000 }),
    });
    renderRecording(result);
  } catch (error) {
    get('recordingStatus').textContent = error.message;
    renderRecording(latestRecording);
  }
}

async function stopRecording() {
  get('stopRecordingButton').disabled = true;
  get('recordingStatus').textContent = 'Stopping recording...';
  try {
    const result = await json('/api/recording/stop', { method: 'POST' });
    renderRecording(result);
  } catch (error) {
    get('recordingStatus').textContent = error.message;
    renderRecording(latestRecording);
  }
}

async function boot() {
  installRecordingPanel();
  meta = await json('/api/meta');
  scene.setMeta(meta);
  renderCapabilities(meta.capabilities);
  get('sceneCaveat').textContent = meta.disclaimer;
  const history = await json('/api/history?seconds=120');
  timeline.setHistory(history.map(adapt));
  const device = await json('/api/device');
  renderDevice(device);
  const logs = await json('/api/logs');
  get('logStatus').textContent = logs.deviceUrl
    ? 'Connected'
    : 'Start with npm run rf -- --device URL';
  (logs.entries || []).forEach(renderLog);
  renderRecording(await json('/api/recording'));
  const nodes = await optionalJson('/api/nodes');
  if (nodes) renderNodes(nodes);

  const stream = new EventSource('/events');
  stream.addEventListener('state', (event) => renderSignal(JSON.parse(event.data)));
  stream.addEventListener('nodes', (event) => renderNodes(JSON.parse(event.data)));
  stream.addEventListener('device', (event) => renderDevice(JSON.parse(event.data)));
  stream.addEventListener('log', (event) => renderLog(JSON.parse(event.data)));
  stream.addEventListener('recording', (event) => renderRecording(JSON.parse(event.data)));
  stream.onerror = () => {
    get('streamStatus').textContent = 'Reconnecting';
  };

  get('pauseButton').onclick = () => {
    paused = !paused;
    get('pauseButton').textContent = paused ? 'Resume' : 'Pause';
    if (!paused && latestSignal) renderSignal(latestSignal);
  };
  get('resetViewButton').onclick = () => scene.resetView();
  get('resetBaselineButton').onclick = async () => {
    await json('/api/baseline/reset', { method: 'POST' });
    get('baselineLabel').textContent = 'Baseline reset. Keep the RF path empty and still.';
  };
  document.querySelectorAll('[data-control]').forEach((button) => {
    button.addEventListener('click', () => void control(button.dataset.control, button));
  });
  document.querySelectorAll('[data-recording-label]').forEach((button) => {
    button.addEventListener(
      'click',
      () => void startRecording(button.dataset.recordingLabel, button),
    );
  });
  get('stopRecordingButton').onclick = () => void stopRecording();
}

function bytes(value) {
  const size = number(value, NaN);
  if (!Number.isFinite(size)) return '—';
  if (size >= 1048576) return `${(size / 1048576).toFixed(1)} MB`;
  return `${Math.round(size / 1024)} KB`;
}

function duration(value) {
  const seconds = number(value, NaN);
  if (!Number.isFinite(seconds)) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${Math.floor(seconds % 60)}s`;
}

function formatSmall(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(6) : '—';
}

boot().catch((error) => {
  get('streamStatus').textContent = error.message;
  setDiagnosis(get('diagnosticBanner'), 'bad', error.message);
});
