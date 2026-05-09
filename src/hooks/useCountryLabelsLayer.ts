import { useEffect, useRef, useMemo, type RefObject } from 'react';
import L from 'leaflet';
import type { ProvinceFeature } from '@/types';
import { useAppState } from '@/state/AppContext';
import { computeBBox, buildCoordSet } from '@/utils/geometry';
import { computeLandmassLabelsForOwner, type LandmassLabel } from '@/utils/connectedComponents';

interface UseCountryLabelsLayerOptions {
  mapRef: RefObject<L.Map | null>;
}

function makeLabelMarker(owner: string, label: LandmassLabel): L.Marker {
  const fontSize = Math.min(20, Math.max(10, Math.sqrt(label.area) * 1.5));
  const html = `<div class="country-label" style="font-size:${fontSize}px">${owner}</div>`;
  const icon = L.divIcon({ html, className: '', iconSize: undefined, iconAnchor: [0, 0] });
  return L.marker([label.lat, label.lon], { icon, interactive: false, keyboard: false });
}

export function useCountryLabelsLayer({ mapRef }: UseCountryLabelsLayerOptions): void {
  const { provinces, layerVisibility } = useAppState();
  const layerRef = useRef<L.LayerGroup | null>(null);

  // Precompute bbox & coord sets ONCE per provinces collection
  const indexes = useMemo(() => {
    const bboxes = new Map<number, ReturnType<typeof computeBBox>>();
    const coordSets = new Map<number, Set<string>>();
    if (!provinces) return { bboxes, coordSets };
    for (const f of provinces.features) {
      const fid = f.properties._fid;
      bboxes.set(fid, computeBBox(f.geometry));
      coordSets.set(fid, buildCoordSet(f.geometry));
    }
    return { bboxes, coordSets };
  }, [provinces]);

  // Group features by current owner whenever ownership changes.
  // Note: we read from provinces.features which has mutable owner properties.
  // To detect changes, we depend on a "version" counter — but simpler is to
  // include the provinces reference. Reducer creates a new state shell on
  // SET_OWNER (returns ...state spread) so this effect re-runs.
  const featuresByOwner = useMemo(() => {
    const map = new Map<string, ProvinceFeature[]>();
    if (!provinces) return map;
    for (const f of provinces.features) {
      const o = f.properties.owner;
      if (!o) continue;
      let arr = map.get(o);
      if (!arr) {
        arr = [];
        map.set(o, arr);
      }
      arr.push(f);
    }
    return map;
    // we want this to recompute on every state change that re-spreads root state
    // (SET_OWNER returns {...state}); using state itself as a coarse trigger
  }, [provinces]);

  // Rebuild the labels layer
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const old = layerRef.current;
    if (old) map.removeLayer(old);

    const group = L.layerGroup();
    for (const [owner, features] of featuresByOwner) {
      const labels = computeLandmassLabelsForOwner(features, indexes.coordSets, indexes.bboxes);
      for (const label of labels) {
        makeLabelMarker(owner, label).addTo(group);
      }
    }
    layerRef.current = group;
    if (layerVisibility.countryLabels) group.addTo(map);
  }, [mapRef, featuresByOwner, indexes, layerVisibility.countryLabels]);

  // Honor toggle
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    if (layerVisibility.countryLabels && !map.hasLayer(layer)) layer.addTo(map);
    else if (!layerVisibility.countryLabels && map.hasLayer(layer)) map.removeLayer(layer);
  }, [mapRef, layerVisibility.countryLabels]);
}
