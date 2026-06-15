import { RfScene } from "/scene-view.js";
import { LiveTimeline } from "/timeline.js";

const scene = new RfScene(document.getElementById("scene"), document.getElementById("sceneTooltip"));
const timeline = new LiveTimeline(document.getElementById("timeline"));

export { scene, timeline };
