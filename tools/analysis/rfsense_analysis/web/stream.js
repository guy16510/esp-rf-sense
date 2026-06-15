export async function getJson(path, options) {
  const response = await fetch(path, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || response.statusText);
  return value;
}

export function pollState(intervalMs, onState, onError) {
  let stopped = false;
  async function next() {
    if (stopped) return;
    try {
      onState(await getJson("/api/state"));
    } catch (error) {
      onError(error);
    }
    setTimeout(next, intervalMs);
  }
  next();
  return () => { stopped = true; };
}
