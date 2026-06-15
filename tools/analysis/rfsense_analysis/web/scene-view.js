import * as d3 from "/d3.js";

export class RfScene {
  constructor(container, tooltip) {
    this.width = 1000;
    this.height = 620;
    this.tooltip = tooltip;
    this.meta = { zones: {} };
    this.trails = new Map();
    this.nodes = { tx: { x: 130, y: 310 }, rx: { x: 870, y: 310 } };
    this.svg = d3.select(container).append("svg").attr("viewBox", `0 0 ${this.width} ${this.height}`);
    const defs = this.svg.append("defs");
    this.marker(defs, "arrow", "#54e39e");
    this.marker(defs, "motionArrow", "#ffca62");
    this.viewport = this.svg.append("g");
    this.grid = this.viewport.append("g").attr("class", "rf-grid");
    this.link = this.viewport.append("g");
    this.zones = this.viewport.append("g");
    this.trailLayer = this.viewport.append("g");
    this.entities = this.viewport.append("g");
    this.nodeLayer = this.viewport.append("g");
    this.zoom = d3.zoom().scaleExtent([0.7, 3.5]).on("zoom", (event) => this.viewport.attr("transform", event.transform));
    this.svg.call(this.zoom);
    this.drawGrid();
    this.drawLink();
    this.drawNodes();
  }

  marker(defs, id, fill) {
    const marker = defs.append("marker").attr("id", id).attr("viewBox", "0 -5 10 10")
      .attr("refX", 8).attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto");
    marker.append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", fill);
  }

  setMeta(meta) {
    this.meta = meta || { zones: {} };
    this.drawZones();
  }

  resetView() {
    this.svg.transition().duration(250).call(this.zoom.transform, d3.zoomIdentity);
  }

  update(scene) {
    const value = scene || { entities: [] };
    this.drawZones(value.zone);
    this.updateTrails(value.entities || []);
    this.drawEntities(value.entities || []);
  }

  drawGrid() {
    const lines = [];
    for (let x = 0; x <= this.width; x += 50) lines.push({ x1: x, y1: 0, x2: x, y2: this.height });
    for (let y = 0; y <= this.height; y += 50) lines.push({ x1: 0, y1: y, x2: this.width, y2: y });
    this.grid.selectAll("line").data(lines).join("line")
      .attr("x1", (d) => d.x1).attr("y1", (d) => d.y1).attr("x2", (d) => d.x2).attr("y2", (d) => d.y2);
  }

  drawLink() {
    const { tx, rx } = this.nodes;
    const dx = rx.x - tx.x;
    const dy = rx.y - tx.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const nx = -dy / length * 105;
    const ny = dx / length * 105;
    const points = [[tx.x + nx * 0.35, tx.y + ny * 0.35], [rx.x + nx, rx.y + ny], [rx.x - nx, rx.y - ny], [tx.x - nx * 0.35, tx.y - ny * 0.35]];
    this.link.selectAll("polygon").data([points]).join("polygon").attr("class", "rf-corridor")
      .attr("points", (d) => d.map((point) => point.join(",")).join(" "));
    this.link.selectAll("line").data([0]).join("line").attr("class", "rf-link")
      .attr("x1", tx.x).attr("y1", tx.y).attr("x2", rx.x).attr("y2", rx.y);
  }

  drawNodes() {
    const data = [{ id: "tx", label: "Wi-Fi AP", ...this.nodes.tx }, { id: "rx", label: "ESP32", ...this.nodes.rx }];
    const drag = d3.drag().on("drag", (event, item) => {
      this.nodes[item.id] = { x: Math.max(35, Math.min(this.width - 35, event.x)), y: Math.max(35, Math.min(this.height - 35, event.y)) };
      this.drawLink();
      this.drawNodes();
    });
    const group = this.nodeLayer.selectAll("g.rf-node").data(data, (d) => d.id).join((enter) => {
      const node = enter.append("g").attr("class", "rf-node");
      node.append("circle").attr("r", 18);
      node.append("text").attr("y", 34);
      return node;
    });
    group.attr("transform", (d) => `translate(${this.nodes[d.id].x},${this.nodes[d.id].y})`).call(drag);
    group.select("text").text((d) => d.label);
  }

  drawZones(active = null) {
    const entries = Object.entries(this.meta?.zones || {});
    const points = entries.map(([label, value], index) => {
      const angle = index / Math.max(entries.length, 1) * Math.PI * 2 - Math.PI / 2;
      return { label, x: Number.isFinite(value?.x) ? 180 + value.x * 80 : 500 + Math.cos(angle) * 205, y: Number.isFinite(value?.y) ? 120 + value.y * 80 : 310 + Math.sin(angle) * 205 };
    });
    const group = this.zones.selectAll("g.zone-group").data(points, (d) => d.label).join((enter) => {
      const zone = enter.append("g").attr("class", "zone-group");
      zone.append("circle").attr("class", "rf-zone").attr("r", 54);
      zone.append("text").attr("class", "rf-zone-label").attr("y", 4);
      return zone;
    });
    group.attr("transform", (d) => `translate(${d.x},${d.y})`);
    group.select("circle").attr("stroke-width", (d) => d.label === active ? 2.5 : 1);
    group.select("text").text((d) => d.label);
  }

  updateTrails(entities) {
    const now = Date.now();
    const active = new Set();
    for (const entity of entities) {
      active.add(entity.id);
      const points = this.trails.get(entity.id) || [];
      points.push({ x: entity.x * this.width, y: entity.y * this.height, time: now });
      this.trails.set(entity.id, points.filter((point) => now - point.time < 12000).slice(-30));
    }
    for (const id of [...this.trails.keys()]) if (!active.has(id)) this.trails.delete(id);
    const path = d3.line().x((d) => d.x).y((d) => d.y).curve(d3.curveCatmullRom.alpha(0.5));
    const data = [...this.trails.entries()].map(([id, points]) => ({ id, points }));
    this.trailLayer.selectAll("path").data(data, (d) => d.id).join("path").attr("class", "trail-line")
      .attr("d", (d) => d.points.length > 1 ? path(d.points) : null);
  }

  drawEntities(data) {
    const groups = this.entities.selectAll("g.rf-entity").data(data, (d) => d.id);
    groups.exit().transition().duration(160).style("opacity", 0).remove();
    const entered = groups.enter().append("g").attr("class", (d) => `rf-entity entity-${this.kind(d.kind)}`).style("opacity", 0);
    entered.append("circle").attr("class", "entity-uncertainty");
    entered.append("circle").attr("class", "entity-core");
    entered.append("g").attr("class", "pose-glyph");
    entered.append("line").attr("class", "orientation-line");
    entered.append("line").attr("class", "velocity-line");
    entered.append("text").attr("class", "entity-label").attr("y", 54);
    entered.append("text").attr("class", "entity-meta").attr("y", 68);
    const merged = entered.merge(groups);
    merged.attr("class", (d) => `rf-entity entity-${this.kind(d.kind)}`)
      .on("pointerenter pointermove", (event, d) => this.showTooltip(event, d))
      .on("pointerleave", () => { this.tooltip.hidden = true; });
    merged.transition().duration(180).style("opacity", 1).attr("transform", (d) => `translate(${d.x * this.width},${d.y * this.height})`);
    merged.select(".entity-uncertainty").attr("r", (d) => Math.max(38, d.uncertainty * 620));
    merged.select(".entity-core").attr("r", (d) => 23 + 11 * d.confidence);
    merged.select(".entity-label").text((d) => d.kind === "occupancy" ? "RF disturbance" : d.kind);
    merged.select(".entity-meta").text((d) => `${d.pose || "unknown pose"} · ${Math.round(d.confidence * 100)}%`);
    merged.each((d, index, nodes) => this.drawGlyph(d3.select(nodes[index]), d));
  }

  drawGlyph(group, entity) {
    const glyph = group.select(".pose-glyph");
    glyph.selectAll("*").remove();
    if (this.kind(entity.kind) === "object") {
      glyph.append("rect").attr("x", -13).attr("y", -13).attr("width", 26).attr("height", 26).attr("rx", 5).attr("class", "pose-line").style("fill", "none");
    } else if (this.kind(entity.kind) === "person") {
      glyph.append("circle").attr("cy", -12).attr("r", 5).attr("class", "pose-line").style("fill", "none");
      glyph.append("line").attr("class", "pose-line").attr("x1", 0).attr("y1", -7).attr("x2", 0).attr("y2", 12);
      glyph.append("line").attr("class", "pose-line").attr("x1", -9).attr("y1", 0).attr("x2", 9).attr("y2", 0);
      glyph.append("line").attr("class", "pose-line").attr("x1", 0).attr("y1", 12).attr("x2", -8).attr("y2", 18);
      glyph.append("line").attr("class", "pose-line").attr("x1", 0).attr("y1", 12).attr("x2", 8).attr("y2", 18);
    }
    const angle = this.orientationAngle(entity.orientation);
    group.select(".orientation-line").attr("x1", 0).attr("y1", 0).attr("x2", Number.isFinite(angle) ? Math.cos(angle) * 42 : 0).attr("y2", Number.isFinite(angle) ? Math.sin(angle) * 42 : 0).style("display", Number.isFinite(angle) ? null : "none");
    group.select(".velocity-line").attr("x1", 0).attr("y1", 0).attr("x2", entity.velocity ? entity.velocity.dx * 420 : 0).attr("y2", entity.velocity ? entity.velocity.dy * 420 : 0).style("display", entity.velocity ? null : "none");
  }

  orientationAngle(value) {
    const text = String(value || "").toLowerCase();
    if (text.includes("display") || text.includes("right")) return 0;
    if (text.includes("away") || text.includes("left")) return Math.PI;
    if (text.includes("up")) return -Math.PI / 2;
    if (text.includes("down")) return Math.PI / 2;
    return Number.NaN;
  }

  kind(value) {
    const text = String(value || "occupancy").toLowerCase();
    if (text.includes("person") || text.includes("people")) return "person";
    if (text !== "occupancy" && text !== "unknown") return "object";
    return "occupancy";
  }

  showTooltip(event, entity) {
    this.tooltip.hidden = false;
    this.tooltip.style.left = `${event.clientX + 14}px`;
    this.tooltip.style.top = `${event.clientY + 14}px`;
    this.tooltip.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = entity.kind;
    const detail = document.createElement("div");
    detail.textContent = `Confidence ${Math.round(entity.confidence * 100)}%, pose ${entity.pose}, orientation ${entity.orientation}, movement ${entity.movement}`;
    const caveat = document.createElement("small");
    caveat.textContent = `Model basis: ${entity.basis}. Position includes uncertainty.`;
    this.tooltip.append(title, detail, caveat);
  }
}
