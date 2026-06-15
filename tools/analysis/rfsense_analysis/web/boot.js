import { RfScene } from "/scene-view.js";
import { LiveTimeline } from "/timeline.js";
import { bindMarkers, refreshMarkers } from "/controls.js";
import { getJson, pollState } from "/stream.js";
import { setStream, showCapabilities, showState } from "/ui.js";

const get = (id) => document.getElementById(id);
const scene = new RfScene(get("scene"), get("sceneTooltip"));
const timeline = new LiveTimeline(get("timeline"));
let meta;
let paused = false;
let latest;

async function start() {
  meta = await getJson("/api/meta");
  scene.setMeta(meta);
  showCapabilities(meta.capabilities);
  get("sceneCaveat").textContent = meta.disclaimer;
  timeline.setHistory(await getJson("/api/history?seconds=120"));
  await refreshMarkers(timeline);
  bindMarkers(timeline);
  pollState(meta.streamIntervalMs || 200, (state) => {
    latest = state;
    if (paused) return;
    showState(state, meta);
    scene.update(state.scene);
    timeline.add(state);
  }, () => setStream("", "Reconnecting"));
  get("pauseButton").onclick = () => {
    paused = !paused;
    get("pauseButton").textContent = paused ? "Resume" : "Pause";
    if (!paused && latest) {
      showState(latest, meta);
      scene.update(latest.scene);
    }
  };
  get("resetViewButton").onclick = () => scene.resetView();
}

start().catch((error) => setStream("", error.message));
