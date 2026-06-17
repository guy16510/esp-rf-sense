import * as d3 from '/d3.js';

export class RfScene {
  constructor(container, tooltip) {
    this.width = 1000;
    this.height = 620;
    this.tooltip = tooltip;
    this.nodes = { tx: { x: 130, y: 310 }, rx: { x: 870, y: 310 } };
    this.svg = d3.select(container).append('svg').attr('viewBox', `0 0 ${this.width} ${this.height}`);
    this.viewport = this.svg.append('g');
    this.grid = this.viewport.append('g').attr('class', 'rf-grid');
    this.linkLayer = this.viewport.append('g');
    this.waveLayer = this.viewport.append('g');
    this.disturbanceLayer = this.viewport.append('g');
    this.nodeLayer = this.viewport.append('g');
    this.zoom = d3.zoom().scaleExtent([0.75, 3]).on('zoom', (event) => this.viewport.attr('transform', event.transform));
    this.svg.call(this.zoom);
    this.drawGrid();
    this.drawLink();
    this.drawNodes();
  }

  setMeta(meta) {
    this.meta = meta || {};
  }

  resetView() {
    this.svg.transition().duration(250).call(this.zoom.transform, d3.zoomIdentity);
  }

  update(scene) {
    const active = Boolean(scene?.active);
    const confidence = Number(scene?.confidence || 0);
    const motion = Number(scene?.motion || 0);
    this.linkLayer.select('.rf-link').classed('active', active);
    this.drawWaves(active, motion);
    this.drawDisturbance(active, confidence, motion, scene?.state, scene?.zone);
  }

  drawGrid() {
    const lines = [];
    for (let x = 0; x <= this.width; x += 50) lines.push({ x1: x, y1: 0, x2: x, y2: this.height });
    for (let y = 0; y <= this.height; y += 50) lines.push({ x1: 0, y1: y, x2: this.width, y2: y });
    this.grid.selectAll('line').data(lines).join('line')
      .attr('x1', (item) => item.x1).attr('y1', (item) => item.y1)
      .attr('x2', (item) => item.x2).attr('y2', (item) => item.y2);
  }

  drawLink() {
    const { tx, rx } = this.nodes;
    const points = [[tx.x, tx.y - 60], [rx.x, rx.y - 115], [rx.x, rx.y + 115], [tx.x, tx.y + 60]];
    this.linkLayer.selectAll('polygon').data([points]).join('polygon').attr('class', 'rf-corridor')
      .attr('points', (value) => value.map((point) => point.join(',')).join(' '));
    this.linkLayer.selectAll('line').data([0]).join('line').attr('class', 'rf-link')
      .attr('x1', tx.x).attr('y1', tx.y).attr('x2', rx.x).attr('y2', rx.y);
  }

  drawNodes() {
    const data = [
      { id: 'tx', label: '2.4 GHz router', ...this.nodes.tx },
      { id: 'rx', label: 'ESP32 CSI receiver', ...this.nodes.rx },
    ];
    const groups = this.nodeLayer.selectAll('g.rf-node').data(data, (item) => item.id).join((enter) => {
      const group = enter.append('g').attr('class', 'rf-node');
      group.append('circle').attr('r', 21);
      group.append('text').attr('y', 39);
      return group;
    });
    groups.attr('transform', (item) => `translate(${item.x},${item.y})`);
    groups.select('text').text((item) => item.label);
  }

  drawWaves(active, motion) {
    const { tx, rx } = this.nodes;
    const count = 7;
    const strength = Math.min(48, 8 + Math.log1p(Math.max(0, motion)) * 10);
    const data = Array.from({ length: count }, (_, index) => {
      const t = (index + 1) / (count + 1);
      const x = tx.x + (rx.x - tx.x) * t;
      const phase = Date.now() / 260 + index;
      return { x, bend: Math.sin(phase) * strength };
    });
    const waves = this.waveLayer.selectAll('path').data(data);
    waves.join('path').attr('class', `rf-wave${active ? ' active' : ''}`)
      .attr('d', (item) => `M${item.x - 32},${tx.y} Q${item.x},${tx.y + item.bend} ${item.x + 32},${tx.y}`);
  }

  drawDisturbance(active, confidence, motion, state, zone) {
    const data = active ? [{ confidence, motion, state, zone }] : [];
    const group = this.disturbanceLayer.selectAll('g').data(data).join((enter) => {
      const value = enter.append('g');
      value.append('ellipse').attr('class', 'rf-disturbance');
      value.append('text').attr('class', 'rf-disturbance-label').attr('y', 5);
      value.append('text').attr('class', 'rf-disturbance-meta').attr('y', 23);
      return value;
    });
    group.attr('transform', 'translate(500,310)')
      .on('pointerenter pointermove', (event, item) => this.showTooltip(event, item))
      .on('pointerleave', () => { this.tooltip.hidden = true; });
    group.select('ellipse')
      .attr('rx', 55 + confidence * 75)
      .attr('ry', 38 + confidence * 50);
    group.select('.rf-disturbance-label').text('RF disturbance');
    group.select('.rf-disturbance-meta').text(`${Math.round(confidence * 100)}% confidence${zone ? `, zone ${zone}` : ''}`);
  }

  showTooltip(event, item) {
    this.tooltip.hidden = false;
    this.tooltip.style.left = `${event.clientX + 14}px`;
    this.tooltip.style.top = `${event.clientY + 14}px`;
    this.tooltip.textContent = `Anonymous link disturbance. Confidence ${Math.round(item.confidence * 100)}%. This is not a measured person coordinate.`;
  }
}
