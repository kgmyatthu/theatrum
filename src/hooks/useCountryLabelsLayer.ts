import { useEffect, useRef, useMemo, type RefObject } from 'react';
import L from 'leaflet';
import type { ProvinceFeature } from '@/types';
import { useAppState } from '@/state/AppContext';
import { computeBBox, buildCoordSet } from '@/utils/geometry';
import { computeLandmassLabelsForOwner, type LandmassLabel } from '@/utils/connectedComponents';

interface UseCountryLabelsLayerOptions {
  mapRef: RefObject<L.Map | null>;
}

/**
 * Auto-shrink scale based on zoom: full size at zoom 4 and above, shrinks
 * down to 50% at the minimum zoom of 2 so labels don't crowd at low zoom.
 */
function zoomScaleFactor(zoom: number): number {
  return Math.min(1.0, Math.max(0.5, zoom / 4));
}

function baseFontSize(area: number): number {
  return Math.min(20, Math.max(10, Math.sqrt(area) * 1.5));
}

function makeLabelMarker(owner: string, label: LandmassLabel, fontSize: number): L.Marker {
  const html = `<div class="country-label" style="font-size:${fontSize}px">${owner}</div>`;
  const icon = L.divIcon({ html, className: '', iconSize: undefined, iconAnchor: [0, 0] });
  return L.marker([label.lat, label.lon], { icon, interactive: false, keyboard: false });
}

interface LabelMarkerEntry {
  marker: L.Marker;
  baseFont: number;
  /** True for the largest landmass of an owner (or its only one). */
  isMainland: boolean;
}

/**
 * At zooms below this, hide every non-mainland label so each country
 * shows once. At/above, show everything.
 */
const SHOW_ALL_LABELS_FROM_ZOOM = 4;

export function useCountryLabelsLayer({ mapRef }: UseCountryLabelsLayerOptions): void {
  const { provinces, layerVisibility, provincesVersion, iconScale } = useAppState();
  const layerRef = useRef<L.LayerGroup | null>(null);
  const markersRef = useRef<LabelMarkerEntry[]>([]);

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

  // Group features by current owner. Province ownership is mutated in place
  // (provinces ref is stable), so depend on provincesVersion to recompute
  // after SET_OWNER and RENAME_COUNTRY. "Unclaimed" is a real owner used
  // for the gray fill but never gets a label — those regions are skipped
  // both for visual clutter at world extent and for the connected-
  // components compute cost (642 features removed from the pass).
  const featuresByOwner = useMemo(() => {
    const map = new Map<string, ProvinceFeature[]>();
    if (!provinces) return map;
    for (const f of provinces.features) {
      const o = f.properties.owner;
      if (!o || o === 'Unclaimed') continue;
      let arr = map.get(o);
      if (!arr) {
        arr = [];
        map.set(o, arr);
      }
      arr.push(f);
    }
    return map;
  }, [provinces, provincesVersion]);

  // Compute label positions ONCE per ownership change. The connected-components
  // pass is O(n²); doing it inside the rebuild effect would re-run on every
  // slider tick and zoom event.
  const ownerLabels = useMemo(() => {
    const out: Array<{ owner: string; label: LandmassLabel; isMainland: boolean }> = [];
    for (const [owner, features] of featuresByOwner) {
      const labels = computeLandmassLabelsForOwner(features, indexes.coordSets, indexes.bboxes);
      if (labels.length === 0) continue;
      let mainlandArea = -Infinity;
      for (const l of labels) {
        if (l.area > mainlandArea) mainlandArea = l.area;
      }
      for (const label of labels) {
        out.push({ owner, label, isMainland: label.area === mainlandArea });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featuresByOwner, indexes]);

  // Build markers when ownership or visibility changes — NOT when scale/zoom
  // change. Initial font size uses the current scale; the next effect updates
  // it in place from then on.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const old = layerRef.current;
    if (old) map.removeLayer(old);

    const initialZoom = map.getZoom();
    const initialScale = iconScale * zoomScaleFactor(initialZoom);
    const initialOnlyMainland = initialZoom < SHOW_ALL_LABELS_FROM_ZOOM;
    const group = L.layerGroup();
    const entries: LabelMarkerEntry[] = [];
    for (const { owner, label, isMainland } of ownerLabels) {
      const baseFont = baseFontSize(label.area);
      const marker = makeLabelMarker(owner, label, baseFont * initialScale);
      entries.push({ marker, baseFont, isMainland });
      marker.addTo(group);
      if (initialOnlyMainland && !isMainland) {
        const icon = (marker as unknown as { _icon?: HTMLElement })._icon;
        if (icon) icon.style.display = 'none';
      }
    }
    layerRef.current = group;
    markersRef.current = entries;
    if (layerVisibility.countryLabels) group.addTo(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapRef, ownerLabels, layerVisibility.countryLabels]);

  // Apply scale on zoom change or when iconScale slider moves. Mutate the
  // existing label DOM directly — no marker rebuild, no connected-components
  // recompute.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = (): void => {
      const zoom = map.getZoom();
      const scale = iconScale * zoomScaleFactor(zoom);
      const onlyMainland = zoom < SHOW_ALL_LABELS_FROM_ZOOM;
      for (const { marker, baseFont, isMainland } of markersRef.current) {
        const icon = (marker as unknown as { _icon?: HTMLElement })._icon;
        if (!icon) continue;
        icon.style.display = onlyMainland && !isMainland ? 'none' : '';
        const el = icon.querySelector<HTMLElement>('.country-label');
        if (el) el.style.fontSize = `${baseFont * scale}px`;
      }
    };
    apply();
    map.on('zoomend', apply);
    return () => {
      map.off('zoomend', apply);
    };
  }, [mapRef, iconScale]);

  // Honor toggle
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    if (layerVisibility.countryLabels && !map.hasLayer(layer)) layer.addTo(map);
    else if (!layerVisibility.countryLabels && map.hasLayer(layer)) map.removeLayer(layer);
  }, [mapRef, layerVisibility.countryLabels]);
}
