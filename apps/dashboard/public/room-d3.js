const D3_URL = 'https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js';
const slots = ['A', 'B', 'C', 'D'];
const positions = {
  A: [0.12, 0.16],
  B: [0.88, 0.16],
  C: [0.12, 0.84],
  D: [0.88, 0.84],
};

let d3;
let latest = null;
const slotAssignments = new Map();
const history = [];

await loadD3();
injectStyles();
const ui = buildControlCenter();
connect();

async function loadD3() {
  if (window.d3) {
    d3 = window.d3;
    return;
  }
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = D3_URL;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Unable to load D3'));
    document.head.append(script);
  });
  d3 = window.d3;
}

function injectStyles() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/room-d3.css?v=2';
  document.head.append(link);
}

function buildControlCenter() {
  document.body.classList.add('rf-control-center');
  const shell = document.querySelector('.shell');
  const overview = document.querySelector('.overview-grid');
  const receivers = document.querySelector('#nodeGrid');
  const analysis = document.querySelector('.analysis-grid');
  const operations = document.querySelector('.operations-grid');
  const resetAllButton = document.querySelector('#resetAllButton');
  document.querySelector('.section-heading')?.remove();

  const workspace = el('section', 'rf-workspace');
  const left = el('div', 'rf-left');
  const middle = el('div', 'rf-middle');
  const right = el('div', 'rf-right');

  const roomPanel = el('article', 'panel rf-room-panel');
  const roomHeading = el('header', 'rf-panel-heading');
  const copy = el('div');
  copy.append(el('span', 'eyebrow', 'ROOM OVERVIEW'));
  copy.append(el('h2', '', 'Live RF presence'));
  copy.append(el('p', 'muted', 'Probabilistic disturbance regions fused from four CSI receivers.'));
  const mode = el('span', 'badge neutral', 'Heuristic estimate');
  const roomActions = el('div', 'rf-room-actions');
  roomActions.append(mode);
  if (resetAllButton) roomActions.append(resetAllButton);
  roomHeading.append(copy, roomActions);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'roomD3';
  svg.setAttribute('viewBox', '0 0 900 610');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'D3 RF presence visualization');

  const roomFooter = el('footer', 'rf-room-footer');
  const roomState = el('strong', '', 'Waiting for receiver data');
  const roomNote = el('small', '', 'Regions are not verified people counts or exact coordinates.');
  const footerCopy = el('div');
  footerCopy.append(roomState, roomNote);
  roomFooter.append(footerCopy);
  roomPanel.append(roomHeading, svg, roomFooter);

  const receiverHeading = el('header', 'rf-receiver-heading');
  const receiverCopy = el('div');
  receiverCopy.append(el('span', 'eyebrow', 'LIVE RECEIVERS'));
  receiverCopy.append(el('h2', '', 'Sensor telemetry'));
  receiverHeading.append(receiverCopy, el('span', 'muted', 'Realtime SSE'));

  left.append(roomPanel);
  if (operations) left.append(operations);
  if (overview) middle.append(overview);
  if (analysis) middle.append(analysis);
  right.append(receiverHeading, receivers);
  workspace.append(left, middle, right);
  shell.replaceChildren(workspace);

  const drawing = d3.select(svg);
  const defs = drawing.append('defs');
  const glow = defs.append('filter').attr('id', 'presenceGlow').attr('x', '-80%').attr('y', '-80%').attr('width', '260%').attr('height', '260%');
  glow.append('feGaussianBlur').attr('stdDeviation', 10).attr('result', 'blur');
  const merge = glow.append('feMerge');
  merge.append('feMergeNode').attr('in', 'blur');
  merge.append('feMergeNode').attr('in', 'SourceGraphic');

  drawing.append('rect').attr('class', 'rf-room-boundary').attr('x', 42).attr('y', 42).attr('width', 816).attr('height', 526).attr('rx', 10);
  drawing.append('rect').attr('class', 'rf-room-inner').attr('x', 62).attr('y', 62).attr('width', 776).attr('height', 486).attr('rx', 6);
  const furniture = drawing.append('g').attr('class', 'rf-furniture');
  furniture.append('rect').attr('x', 275).attr('y', 466).attr('width', 330).attr('height', 62).attr('rx', 5);
  furniture.append('circle').attr('cx', 695).attr('cy', 332).attr('r', 32);

  return {
    drawing,
    links: drawing.append('g').attr('class', 'rf-links'),
    regions: drawing.append('g').attr('class', 'rf-regions'),
    nodes: drawing.append('g').attr('class', 'rf-nodes'),
    roomState,
    mode,
  };
}

function connect() {
  fetch('/api/nodes').then((response) => response.json()).then(render).catch(() => undefined);
  const stream = new EventSource('/events');
  stream.addEventListener('nodes', (event) => render(JSON.parse(event.data)));
}

function render(snapshot) {
  latest = snapshot;
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const fused = snapshot.fused || {};
  const assigned = assignSlots(nodes);
  const nodeData = slots.map((slot) => ({
    slot,
    node: assigned.get(slot),
    x: positions[slot][0],
    y: positions[slot][1],
  }));

  drawLinks(nodeData);
  drawNodes(nodeData);
  drawRegions(nodeData, fused);
  ui.roomState.textContent = stateLabel(fused.state);
  ui.mode.textContent = nodes.some((node) => node.mode === 'portable-model')
    ? 'Trained model'
    : 'Heuristic estimate';
  history.push({ confidence: finite(fused.confidence), motion: finite(fused.motion) });
  if (history.length > 120) history.shift();
}

function assignSlots(nodes) {
  const assigned = new Map(slots.map((slot) => [slot, null]));
  for (const node of nodes) {
    const id = String(node.deviceId || 'unknown');
    if (!slotAssignments.has(id)) {
      const used = new Set(slotAssignments.values());
      const free = slots.find((slot) => !used.has(slot));
      if (free) slotAssignments.set(id, free);
    }
    const slot = slotAssignments.get(id);
    if (slot) assigned.set(slot, node);
  }
  return assigned;
}

function drawLinks(nodeData) {
  const x = scaleX;
  const y = scaleY;
  ui.links
    .selectAll('line')
    .data(nodeData, (item) => item.slot)
    .join('line')
    .attr('x1', (item) => x(item.x))
    .attr('y1', (item) => y(item.y))
    .attr('x2', 450)
    .attr('y2', 305)
    .attr('class', (item) => (isReady(item.node) ? 'rf-link ready' : 'rf-link stale'));
}

function drawNodes(nodeData) {
  const groups = ui.nodes
    .selectAll('g.rf-node')
    .data(nodeData, (item) => item.slot)
    .join((enter) => {
      const group = enter.append('g').attr('class', 'rf-node');
      group.append('circle').attr('r', 28);
      group.append('text').attr('text-anchor', 'middle').attr('dy', '0.35em');
      return group;
    });
  groups.attr('transform', (item) => `translate(${scaleX(item.x)},${scaleY(item.y)})`);
  groups.select('circle').attr('class', (item) => {
    if (!item.node) return 'rf-node-dot missing';
    if (!isReady(item.node)) return 'rf-node-dot stale';
    return item.node.state === 'active' ? 'rf-node-dot active' : 'rf-node-dot ready';
  });
  groups.select('text').text((item) => item.slot);
}

function drawRegions(nodeData, fused) {
  const contributors = nodeData.filter((item) => isReady(item.node));
  const active = fused.state === 'active' && contributors.length > 0;
  const regionData = active ? [estimateRegion(contributors, fused)] : [];
  const groups = ui.regions
    .selectAll('g.rf-region')
    .data(regionData, (item) => item.id)
    .join(
      (enter) => {
        const group = enter.append('g').attr('class', 'rf-region').style('opacity', 0);
        group.append('circle').attr('class', 'rf-region-halo').attr('r', 0);
        group.append('circle').attr('class', 'rf-region-core').attr('r', 0);
        return group;
      },
      (update) => update,
      (exit) => exit.transition().duration(180).style('opacity', 0).remove(),
    );
  groups
    .transition()
    .duration(240)
    .style('opacity', 1)
    .attr('transform', (item) => `translate(${scaleX(item.x)},${scaleY(item.y)})`);
  groups.select('.rf-region-core').transition().duration(240).attr('r', (item) => item.radius);
  groups.select('.rf-region-halo').transition().duration(240).attr('r', (item) => item.radius * 1.7);
}

function estimateRegion(contributors, fused) {
  const weighted = contributors.map((item) => {
    const activation = Math.max(0.03, finite(item.node?.diagnostics?.activationScore));
    const age = finite(item.node?.ageSec, 99);
    const quality = Math.max(0.05, 1 - Math.min(3, age) / 3);
    return { ...item, weight: activation * quality };
  });
  const total = weighted.reduce((sum, item) => sum + item.weight, 0) || 1;
  const rawX = weighted.reduce((sum, item) => sum + item.x * item.weight, 0) / total;
  const rawY = weighted.reduce((sum, item) => sum + item.y * item.weight, 0) / total;
  const confidence = clamp(fused.confidence);
  return {
    id: 'fused-presence-region',
    x: rawX * 0.62 + 0.5 * 0.38,
    y: rawY * 0.62 + 0.5 * 0.38,
    radius: 44 + (1 - confidence) * 46 + Math.min(28, finite(fused.motion) * 5),
  };
}

function isReady(node) {
  return Boolean(node?.ready && node.ageSec !== null && finite(node.ageSec, 99) <= 3);
}

function scaleX(value) {
  return 62 + value * 776;
}

function scaleY(value) {
  return 62 + value * 486;
}

function stateLabel(state) {
  if (state === 'active') return 'RF presence detected';
  if (state === 'clear') return 'Room clear';
  if (state === 'baseline') return 'Learning baselines';
  return 'Waiting for receiver data';
}

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value) {
  return Math.max(0, Math.min(1, finite(value)));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function getLatestRoomSnapshot() {
  return latest;
}
