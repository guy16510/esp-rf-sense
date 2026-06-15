import * as d3 from '/d3.js';
import { RfScene } from '/scene-view.js';
import { LiveTimeline } from '/timeline.js';

const get = (id) => document.getElementById(id);
const percent = (value) => `${Math.round(Number(value || 0) * 100)}%`;
const scene = new RfScene(get('scene'), get('sceneTooltip'));
const timeline = new LiveTimeline(get('timeline'));
let meta;
let latest;
let paused = false;

function adapt(state) {
  const entities = (state.bubbles || []).map((bubble) => ({
    id: bubble.id,
    kind: 'occupancy',
    x: bubble.x,
    y: bubble.y,
    confidence: bubble.confidence,
    uncertainty: Math.max(0.08, bubble.radius),
    pose: 'unknown',
    orientation: 'unknown',
    movement: bubble.motion > 0 ? 'active' : 'still',
    motion: bubble.motion,
    label: state.state,
    basis: state.mode,
  }));
  return {
    ...state,
    ts: state.timestamp,
    scene: {
      entities,
      audience: {
        estimate: entities.length > 0 ? 1 : 0,
        min: 0,
        max: entities.length > 0 ? 1 : 0,
        confidence: state.confidence,
      },
      zone: state.zone,
      directionKnown: false,
      caveat: meta?.disclaimer || 'Anonymous aggregate RF activity.',
    },
  };
}

function render(raw) {
  latest = raw;
  if (paused) return;
  const state = adapt(raw);
  const age = raw.ageSec;
  const stale = Number.isFinite(age) && age > 3;
  get('streamDot').className = raw.state === 'waiting' ? '' : stale ? 'stale' : 'live';
  get('streamStatus').textContent = raw.state === 'waiting' ? 'Waiting' : stale ? `Stale ${age.toFixed(1)}s` : 'Live';
  get('audienceValue').textContent = raw.state === 'active' ? 'Activity' : raw.state === 'clear' ? 'Clear' : '—';
  get('audienceRange').textContent = raw.state === 'active' ? 'Anonymous RF disturbance detected' : 'No active disturbance';
  get('stateValue').textContent = raw.state;
  get('targetValue').textContent = `Runtime: ${raw.mode}`;
  get('confidenceValue').textContent = percent(raw.confidence);
  get('confidenceBar').firstElementChild.style.width = percent(raw.confidence);
  get('motionValue').textContent = Number(raw.motion || 0).toFixed(3);
  get('directionValue').textContent = raw.zone ? `Zone ${raw.zone}` : 'Zone unavailable';
  const quality = Math.max(0, 100 - Math.min(60, Number(raw.lossPpm || 0) / 200) - (stale ? 35 : 0));
  get('qualityValue').textContent = `${Math.round(quality)}%`;
  get('qualityDetail').textContent = `${raw.frameRateHz.toFixed(1)} Hz, ${raw.lossPpm} ppm loss`;
  get('deviceValue').textContent = raw.deviceId || 'aggregate stream';
  get('frameRateValue').textContent = `${raw.frameRateHz.toFixed(1)} Hz`;
  get('lossValue').textContent = `${raw.lossPpm} ppm`;
  get('subcarrierValue').textContent = raw.amplitudeProfile.length;
  get('streamAgeValue').textContent = Number.isFinite(age) ? `${age.toFixed(2)} sec` : '—';
  get('modeValue').textContent = raw.mode;
  get('sceneCaveat').textContent = state.scene.caveat;
  renderScores(raw.scores || {});
  renderProfile(raw.amplitudeProfile || []);
  scene.update(state.scene);
  timeline.add(state);
}

function renderScores(scores) {
  const root = get('scoreList');
  root.replaceChildren();
  const entries = Object.entries(scores).sort((left, right) => right[1] - left[1]);
  if (!entries.length) {
    const text = document.createElement('p');
    text.className = 'muted';
    text.textContent = 'Waiting for classifier output.';
    root.append(text);
    return;
  }
  for (const [label, value] of entries) {
    const row = document.createElement('div');
    row.className = 'score-row';
    const name = document.createElement('label');
    name.textContent = label;
    const track = document.createElement('span');
    track.className = 'score-track';
    const bar = document.createElement('i');
    bar.style.width = percent(value);
    track.append(bar);
    const score = document.createElement('strong');
    score.textContent = percent(value);
    row.append(name, track, score);
    root.append(row);
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

function renderProfile(values) {
  const svg = d3.select('#profileChart');
  if (!values.length) {
    svg.selectAll('*').remove();
    return;
  }
  const x = d3.scaleLinear().domain([0, values.length - 1]).range([36, 986]);
  const extent = d3.extent(values);
  const domain = extent[0] === extent[1] ? [extent[0] - 1, extent[1] + 1] : extent;
  const y = d3.scaleLinear().domain(domain).nice().range([158, 14]);
  const line = d3.line().x((_, index) => x(index)).y((value) => y(value)).curve(d3.curveMonotoneX);
  svg.selectAll('path.profile').data([values]).join('path').attr('class', 'profile').attr('fill', 'none').attr('stroke', '#39d9ff').attr('stroke-width', 1.8).attr('d', line);
}

async function json(url, options) {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || response.statusText);
  return value;
}

async function refreshEvents() {
  const events = await json('/api/events');
  timeline.setMarkers(events.map((event) => ({ ...event, ts: event.timestamp })));
}

async function boot() {
  meta = await json('/api/meta');
  scene.setMeta(meta);
  renderCapabilities(meta.capabilities);
  const history = await json('/api/history?seconds=120');
  timeline.setHistory(history.map(adapt));
  await refreshEvents();

  const stream = new EventSource('/events');
  stream.addEventListener('state', (event) => render(JSON.parse(event.data)));
  stream.onopen = () => { get('streamStatus').textContent = 'Live'; };
  stream.onerror = () => { get('streamStatus').textContent = 'Reconnecting'; };

  get('pauseButton').onclick = () => {
    paused = !paused;
    get('pauseButton').textContent = paused ? 'Resume' : 'Pause';
    if (!paused && latest) render(latest);
  };
  get('resetViewButton').onclick = () => scene.resetView();
  document.querySelectorAll('[data-marker]').forEach((button) => button.addEventListener('click', async () => {
    const type = button.dataset.marker;
    await json('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        label: type.replace('_', ' '),
        groupId: get('campaignId').value.trim(),
        timestamp: Date.now() / 1000,
      }),
    });
    await refreshEvents();
  }));
}

boot().catch((error) => { get('streamStatus').textContent = error.message; });
