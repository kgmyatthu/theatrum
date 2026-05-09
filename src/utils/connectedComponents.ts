import type { ProvinceFeature } from '@/types';
import { bboxesAdjacent, setsIntersect, computeBBox } from './geometry';

export interface LandmassLabel {
  lon: number;
  lat: number;
  /** sq.degrees — used to scale font size. */
  area: number;
}

const MIN_LANDMASS_AREA_DEG2 = 0.5;

/**
 * Group features into connected components using shared-coordinate adjacency.
 * Two features are connected if they share at least one rounded vertex.
 */
function findConnectedComponents(
  features: ProvinceFeature[],
  coordSets: Map<number, Set<string>>,
): ProvinceFeature[][] {
  const n = features.length;
  if (n === 0) return [];

  const parent: number[] = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let cur = x;
    while (parent[cur] !== cur) {
      const p = parent[cur]!;
      parent[cur] = parent[p]!;
      cur = parent[cur]!;
    }
    return cur;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const bboxes = features.map((f) => computeBBox(f.geometry));

  for (let i = 0; i < n; i++) {
    const fidI = features[i]!.properties._fid;
    const setI = coordSets.get(fidI);
    if (!setI) continue;
    for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue;
      if (!bboxesAdjacent(bboxes[i]!, bboxes[j]!)) continue;
      const fidJ = features[j]!.properties._fid;
      const setJ = coordSets.get(fidJ);
      if (!setJ) continue;
      if (setsIntersect(setI, setJ)) union(i, j);
    }
  }

  const groups = new Map<number, ProvinceFeature[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let arr = groups.get(root);
    if (!arr) {
      arr = [];
      groups.set(root, arr);
    }
    arr.push(features[i]!);
  }
  return Array.from(groups.values());
}

/**
 * Compute one label per connected landmass for the given owner.
 * Returns at most one label per physically separated chunk of territory.
 */
export function computeLandmassLabelsForOwner(
  ownerFeatures: ProvinceFeature[],
  coordSets: Map<number, Set<string>>,
  bboxes: Map<number, ReturnType<typeof computeBBox>>,
): LandmassLabel[] {
  if (ownerFeatures.length === 0) return [];
  const components = findConnectedComponents(ownerFeatures, coordSets);
  const labels: LandmassLabel[] = [];

  for (const comp of components) {
    let sumX = 0;
    let sumY = 0;
    let sumW = 0;
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;

    for (const feat of comp) {
      const bb = bboxes.get(feat.properties._fid);
      if (!bb) continue;
      const w = (bb.maxLon - bb.minLon) * (bb.maxLat - bb.minLat);
      sumX += ((bb.minLon + bb.maxLon) / 2) * w;
      sumY += ((bb.minLat + bb.maxLat) / 2) * w;
      sumW += w;
      if (bb.minLon < minLon) minLon = bb.minLon;
      if (bb.minLat < minLat) minLat = bb.minLat;
      if (bb.maxLon > maxLon) maxLon = bb.maxLon;
      if (bb.maxLat > maxLat) maxLat = bb.maxLat;
    }

    const area = (maxLon - minLon) * (maxLat - minLat);
    if (area < MIN_LANDMASS_AREA_DEG2) continue;

    labels.push({
      lon: sumW > 0 ? sumX / sumW : (minLon + maxLon) / 2,
      lat: sumW > 0 ? sumY / sumW : (minLat + maxLat) / 2,
      area,
    });
  }

  return labels;
}
