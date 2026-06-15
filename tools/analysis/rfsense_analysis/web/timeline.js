import * as d3 from "/d3.js";

export class LiveTimeline {
  constructor(container) {
    this.width = 1200;
    this.height = 260;
    this.margin = { top: 18, right: 45, bottom: 32, left: 46 };
    this.samples = [];
    this.markers = [];
    this.svg = d3.select(container).append("svg").attr("viewBox", `0 0 ${this.width} ${this.height}`);
    this.grid = this.svg.append("g");
    this.markerLayer = this.svg.append("g");
    this.seriesLayer = this.svg.append("g");
    this.axisX = this.svg.append("g");
    this.axisY = this.svg.append("g");
    this.crosshair = this.svg.append("line").attr("stroke", "rgba(255,255,255,.32)")
      .attr("y1", this.margin.top).attr("y2", this.height - this.margin.bottom).style("display", "none");
    this.svg.append("rect").attr("fill", "transparent").style("cursor", "crosshair")
      .attr("x", this.margin.left).attr("y", this.margin.top)
      .attr("width", this.width - this.margin.left - this.margin.right)
      .attr("height", this.height - this.margin.top - this.margin.bottom)
      .on("pointermove", (event) => this.hover(event)).on("pointerleave", () => this.crosshair.style("display", "none"));
  }

  setHistory(states) {
    this.samples = (states || []).filter((state) => state?.ts).map((state) => this.sample(state)).slice(-900);
    this.render();
  }

  add(state) {
    if (!state?.ts) return;
    this.samples.push(this.sample(state));
    const cutoff = state.ts - 180;
    this.samples = this.samples.filter((sample) => sample.ts >= cutoff).slice(-900);
    this.render();
  }

  setMarkers(markers) {
    this.markers = markers || [];
    this.render();
  }

  sample(state) {
    return {
      ts: Number(state.ts),
      confidence: Number(state.confidence || 0),
      motion: Number(state.motion || 0),
      count: Number(state.scene?.audience?.estimate || 0),
    };
  }

  render() {
    if (!this.samples.length) return;
    const start = this.samples[0].ts;
    const end = Math.max(this.samples.at(-1).ts, start + 1);
    const x = d3.scaleTime().domain([new Date(start * 1000), new Date(end * 1000)])
      .range([this.margin.left, this.width - this.margin.right]);
    const maxMotion = Math.max(d3.max(this.samples, (d) => d.motion) || 1, 1e-6);
    const maxCount = Math.max(d3.max(this.samples, (d) => d.count) || 1, 1);
    const y = d3.scaleLinear().domain([0, 1]).range([this.height - this.margin.bottom, this.margin.top]);
    const normalized = this.samples.map((sample) => ({
      ...sample,
      motionValue: Math.min(1, sample.motion / maxMotion),
      countValue: Math.min(1, sample.count / maxCount),
    }));
    this.grid.call(d3.axisLeft(y).ticks(4).tickSize(-(this.width - this.margin.left - this.margin.right)).tickFormat(""))
      .attr("transform", `translate(${this.margin.left},0)`);
    this.grid.selectAll("line").attr("stroke", "rgba(148,163,184,.09)");
    this.grid.select(".domain").remove();
    this.axisX.attr("transform", `translate(0,${this.height - this.margin.bottom})`)
      .call(d3.axisBottom(x).ticks(8).tickFormat(d3.timeFormat("%H:%M:%S")));
    this.axisY.attr("transform", `translate(${this.margin.left},0)`)
      .call(d3.axisLeft(y).ticks(4).tickFormat(d3.format(".0%")));
    this.svg.selectAll(".tick text").attr("fill", "#8b9bb1");
    this.svg.selectAll(".domain,.tick line").attr("stroke", "rgba(148,163,184,.2)");
    const line = (field) => d3.line().x((d) => x(new Date(d.ts * 1000))).y((d) => y(d[field])).curve(d3.curveMonotoneX);
    const series = [
      { id: "confidence", field: "confidence", color: "#54e39e" },
      { id: "motion", field: "motionValue", color: "#ffca62" },
      { id: "count", field: "countValue", color: "#39d9ff" },
    ];
    this.seriesLayer.selectAll("path.series").data(series, (item) => item.id).join("path")
      .attr("class", "series").attr("fill", "none").attr("stroke", (item) => item.color)
      .attr("stroke-width", 2.2).attr("d", (item) => line(item.field)(normalized));
    const visibleMarkers = this.markers.filter((marker) => marker.ts >= start && marker.ts <= end);
    const marks = this.markerLayer.selectAll("g.marker").data(visibleMarkers, (marker) => marker.id).join((enter) => {
      const group = enter.append("g").attr("class", "marker");
      group.append("line").attr("y1", this.margin.top).attr("y2", this.height - this.margin.bottom)
        .attr("stroke-width", 1.5).attr("stroke-dasharray", "3 4");
      group.append("text").attr("y", this.margin.top + 10).attr("font-size", 9).attr("transform", "rotate(-35)");
      return group;
    });
    marks.attr("transform", (marker) => `translate(${x(new Date(marker.ts * 1000))},0)`);
    marks.select("line").attr("stroke", (marker) => marker.type === "interaction" ? "#a78bfa" : "#ff6f7d");
    marks.select("text").attr("fill", "#b8c3d2").text((marker) => marker.label || marker.type.replace("_", " "));
    this.x = x;
  }

  hover(event) {
    if (!this.x || !this.samples.length) return;
    const [pixel] = d3.pointer(event, this.svg.node());
    const time = this.x.invert(pixel).getTime() / 1000;
    const index = d3.bisector((sample) => sample.ts).center(this.samples, time);
    const sample = this.samples[index];
    if (!sample) return;
    const x = this.x(new Date(sample.ts * 1000));
    this.crosshair.style("display", null).attr("x1", x).attr("x2", x);
  }
}
