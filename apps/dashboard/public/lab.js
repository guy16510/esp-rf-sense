const histories = new Map();

const nodesRoot = document.querySelector('#nodes');
const readiness = document.querySelector('#readiness');
const online = document.querySelector('#online');
const fusedState = document.querySelector('#fusedState');
const fusedMotion = document.querySelector('#fusedMotion');
const disagreement = document.querySelector('#disagreement');

function safeNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function nodeHistory(id) {
  let history = histories.get(id);
  if (!history) {
    history = { motion: [], amplitude: [] };
    histories.set(id, history);
  }
  return history;
}

function pushLimited(values, value, limit) {
  values.push(value);
  if (values.length > limit) values.splice(0, values.length - limit);
}

function drawLine(canvas, values) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(300, canvas.clientWidth);
  const height = 150;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = '#233149';
  ctx.lineWidth = 1;
  for (let y = 30; y < height; y += 30) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
  if (!values.length) return;
  const max = Math.max(...values, 0.000001);
  ctx.strokeStyle = '#68a7ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = values.length === 1 ? width : (index / (values.length - 1)) * width;
    const y = height - 8 - (value / max) * (height - 16);
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawProfile(canvas, values) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(300, canvas.clientWidth);
  const height = 150;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.clearRect(0, 0, width, height);
  if (!values.length) return;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 0.000001);
  const barWidth = width / values.length;
  values.forEach((value, index) => {
    const normalized = (value - min) / span;
    const barHeight = 6 + normalized * (height - 12);
    ctx.fillStyle = `hsl(${215 - normalized * 75} 75% ${42 + normalized * 18}%)`;
    ctx.fillRect(index * barWidth, height - barHeight, Math.max(1, barWidth - 1), barHeight);
  });
}

function render(state) {
  const required = state.readiness?.requiredNodeCount ?? 4;
  const onlineCount = state.readiness?.onlineNodeCount ?? 0;
  online.textContent = `${onlineCount} / ${required}`;
  const ready = Boolean(state.readiness?.readyForCapture);
  readiness.textContent = ready ? 'Ready for capture' : 'Waiting for physical nodes';
  readiness.classList.toggle('ready', ready);
  fusedState.textContent = String(state.fused?.state ?? 'waiting').replaceAll('_', ' ');
  fusedMotion.textContent = safeNumber(state.fused?.motion).toFixed(4);
  disagreement.textContent = `${Math.round(safeNumber(state.fused?.disagreement) * 100)}%`;

  const nodes = Array.isArray(state.nodes) ? state.nodes : [];
  if (!nodes.length) {
    nodesRoot.innerHTML = '<div class="card empty">No real CSI nodes have reported yet.</div>';
    return;
  }

  nodesRoot.innerHTML = nodes.map((node) => {
    const id = String(node.deviceId ?? 'unknown');
    return `<article class="card" data-node="${id}">
      <div class="node-head"><div><div class="eyebrow">PHYSICAL SENSOR</div><h2>Node ${id}</h2></div><span class="pill ${node.ready ? 'ready' : ''}">${node.ready ? 'LIVE' : 'STALE'}</span></div>
      <div class="stats">
        <div class="stat"><span>State</span><strong>${String(node.state ?? 'waiting')}</strong></div>
        <div class="stat"><span>Motion</span><strong>${safeNumber(node.motion).toFixed(4)}</strong></div>
        <div class="stat"><span>RSSI</span><strong>${node.averageRssi == null ? 'N/A' : `${safeNumber(node.averageRssi).toFixed(1)} dBm`}</strong></div>
        <div class="stat"><span>Frame rate</span><strong>${safeNumber(node.frameRateHz).toFixed(1)} Hz</strong></div>
        <div class="stat"><span>CSI bytes</span><strong>${safeNumber(node.csiLength)}</strong></div>
        <div class="stat"><span>Subcarriers</span><strong>${safeNumber(node.subcarrierCount)}</strong></div>
        <div class="stat"><span>Packet loss</span><strong>${(safeNumber(node.lossPpm) / 10000).toFixed(2)}%</strong></div>
        <div class="stat"><span>Last frame</span><strong>${node.ageSec == null ? 'Never' : `${safeNumber(node.ageSec).toFixed(1)}s`}</strong></div>
      </div>
      <div class="chart-label">Rolling motion evidence</div><canvas class="motion-chart"></canvas>
      <div class="chart-label">Current CSI amplitude by subcarrier</div><canvas class="profile-chart"></canvas>
    </article>`;
  }).join('');

  for (const node of nodes) {
    const id = String(node.deviceId ?? 'unknown');
    const history = nodeHistory(id);
    pushLimited(history.motion, safeNumber(node.motion), 180);
    history.amplitude = Array.isArray(node.amplitudeProfile) ? node.amplitudeProfile.map(Number) : [];
    const card = nodesRoot.querySelector(`[data-node="${CSS.escape(id)}"]`);
    if (!card) continue;
    drawLine(card.querySelector('.motion-chart'), history.motion);
    drawProfile(card.querySelector('.profile-chart'), history.amplitude);
  }
}

async function refresh() {
  try {
    const response = await fetch('/api/lab/state', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    readiness.textContent = `Disconnected: ${error.message}`;
    readiness.classList.remove('ready');
  }
}

await refresh();
setInterval(refresh, 500);
window.addEventListener('resize', refresh);
