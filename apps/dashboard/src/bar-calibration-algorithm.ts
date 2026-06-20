export interface ConfusionCell {
  actual: string;
  predicted: string;
  count: number;
}

export interface RecaptureRecommendation {
  zones: string[];
  pairs: Array<{ left: string; right: string; count: number }>;
}

export interface CaptureQualityInput {
  elapsedSeconds: number;
  frames: number;
  receiverCount: number;
  uniqueBuckets: number;
  invalidFraction: number;
}

export interface CaptureQualityDecision {
  stop: boolean;
  score: number;
  reasons: string[];
}

export interface PlacementPoint {
  x: number;
  y: number;
  z?: number;
}

export interface PlacementScore {
  score: number;
  pass: boolean;
  xCoverage: number;
  yCoverage: number;
  minimumPairDistance: number;
  triangleAreaCoverage: number;
  heightDiversity: number;
  reasons: string[];
}

export interface TransitionDecision {
  zone: string;
  accepted: boolean;
  reason: string | null;
}

const BAR_GRAPH: Record<string, string[]> = {
  'near-left': ['near-center', 'far-left'],
  'near-center': ['near-left', 'near-right', 'far-center'],
  'near-right': ['near-center', 'far-right'],
  'far-left': ['near-left', 'far-center'],
  'far-center': ['far-left', 'far-right', 'near-center'],
  'far-right': ['far-center', 'near-right'],
};

export function recommendRecaptures(
  cells: readonly ConfusionCell[],
  minimumCount = 2,
): RecaptureRecommendation {
  const pairs = new Map<string, { left: string; right: string; count: number }>();
  for (const cell of cells) {
    if (cell.actual === cell.predicted || cell.count < minimumCount) continue;
    const labels = [cell.actual, cell.predicted].sort();
    const left = labels[0]!;
    const right = labels[1]!;
    const key = `${left}|${right}`;
    const prior = pairs.get(key);
    if (prior) prior.count += cell.count;
    else pairs.set(key, { left, right, count: cell.count });
  }
  const ordered = [...pairs.values()].sort((a, b) => b.count - a.count);
  return {
    zones: [...new Set(ordered.flatMap((item) => [item.left, item.right]))],
    pairs: ordered,
  };
}

export function captureQuality(input: CaptureQualityInput): CaptureQualityDecision {
  const reasons: string[] = [];
  if (input.elapsedSeconds < 8) reasons.push('capture is too short');
  if (input.frames < 180) reasons.push('not enough frames');
  if (input.receiverCount < 4) reasons.push('all four receivers are required');
  if (input.uniqueBuckets < 12) reasons.push('signal diversity is too low');
  if (input.invalidFraction > 0.05) reasons.push('too many invalid frames');
  const score = clamp01(
    Math.min(1, input.elapsedSeconds / 15) * 0.15 +
      Math.min(1, input.frames / 300) * 0.30 +
      Math.min(1, input.receiverCount / 4) * 0.20 +
      Math.min(1, input.uniqueBuckets / 20) * 0.25 +
      Math.max(0, 1 - input.invalidFraction / 0.05) * 0.10,
  );
  return { stop: reasons.length === 0 && score >= 0.82, score, reasons };
}

export function scorePlacement(
  points: readonly PlacementPoint[],
  width: number,
  height: number,
): PlacementScore {
  if (points.length !== 4 || width <= 0 || height <= 0) {
    return {
      score: 0,
      pass: false,
      xCoverage: 0,
      yCoverage: 0,
      minimumPairDistance: 0,
      triangleAreaCoverage: 0,
      heightDiversity: 0,
      reasons: ['four receiver coordinates and positive room dimensions are required'],
    };
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const xCoverage = (Math.max(...xs) - Math.min(...xs)) / width;
  const yCoverage = (Math.max(...ys) - Math.min(...ys)) / height;
  let minimumPairDistance = Number.POSITIVE_INFINITY;
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      const dx = (points[left]!.x - points[right]!.x) / width;
      const dy = (points[left]!.y - points[right]!.y) / height;
      minimumPairDistance = Math.min(minimumPairDistance, Math.hypot(dx, dy));
    }
  }
  const hullArea = polygonArea(convexHull(points));
  const triangleAreaCoverage = hullArea / (width * height);
  const heights = points.map((point) => point.z ?? 0);
  const heightDiversity = Math.min(1, (Math.max(...heights) - Math.min(...heights)) / 1.5);
  const score = clamp01(
    Math.min(1, xCoverage / 0.7) * 0.28 +
      Math.min(1, yCoverage / 0.7) * 0.28 +
      Math.min(1, minimumPairDistance / 0.25) * 0.18 +
      Math.min(1, triangleAreaCoverage / 0.28) * 0.18 +
      heightDiversity * 0.08,
  );
  const reasons: string[] = [];
  if (xCoverage < 0.5) reasons.push('receivers do not span enough bar width');
  if (yCoverage < 0.5) reasons.push('receivers do not span enough depth');
  if (minimumPairDistance < 0.15) reasons.push('at least two receivers are too close together');
  if (triangleAreaCoverage < 0.12) reasons.push('receiver geometry is too collinear');
  return {
    score,
    pass: reasons.length === 0 && score >= 0.65,
    xCoverage,
    yCoverage,
    minimumPairDistance,
    triangleAreaCoverage,
    heightDiversity,
    reasons,
  };
}

export function transitionDecision(
  previousZone: string | null,
  candidateZone: string,
  elapsedMs: number,
  confidence: number,
): TransitionDecision {
  if (!previousZone || previousZone === candidateZone) {
    return { zone: candidateZone, accepted: true, reason: null };
  }
  if (elapsedMs >= 1200 || confidence >= 0.9) {
    return { zone: candidateZone, accepted: true, reason: null };
  }
  const adjacent = BAR_GRAPH[previousZone]?.includes(candidateZone) ?? true;
  return adjacent
    ? { zone: candidateZone, accepted: true, reason: null }
    : {
        zone: previousZone,
        accepted: false,
        reason: `rejected physically implausible jump from ${previousZone} to ${candidateZone}`,
      };
}

export function secondPassGroup(base: string, pass: number, subject: string, day: string): string {
  return `${base}:pass-${Math.max(1, Math.floor(pass))}:subject-${subject}:day-${day}`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function convexHull(points: readonly PlacementPoint[]): PlacementPoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (origin: PlacementPoint, a: PlacementPoint, b: PlacementPoint) =>
    (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  const lower: PlacementPoint[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: PlacementPoint[] = [];
  for (const point of sorted.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function polygonArea(points: readonly PlacementPoint[]): number {
  if (points.length < 3) return 0;
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    total += current.x * next.y - next.x * current.y;
  }
  return Math.abs(total) / 2;
}
