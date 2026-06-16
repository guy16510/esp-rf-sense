export async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}

export async function refreshMarkers(timeline) {
  timeline.setMarkers(await requestJson("/api/markers"));
}

export function bindMarkers(timeline) {
  const campaign = document.getElementById("campaignId");
  document.querySelectorAll("[data-marker]").forEach((button) => {
    button.addEventListener("click", async () => {
      const type = button.dataset.marker;
      await requestJson("/api/markers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          campaignId: campaign.value.trim(),
          label: type.replace("_", " "),
          ts: Date.now() / 1000,
        }),
      });
      await refreshMarkers(timeline);
    });
  });
}
