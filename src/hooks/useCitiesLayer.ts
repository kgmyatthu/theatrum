import { useEffect, useRef, type RefObject } from 'react';
import L from 'leaflet';
import type { City } from '@/types';
import { useAppState } from '@/state/AppContext';

interface UseCitiesLayerOptions {
  mapRef: RefObject<L.Map | null>;
}

// All cities — including the smallest towns (rank 7-10) — appear together
// at zoom >= 9, sharing the tier where towns (rank 6) already showed up.
// Below that, a coarse-to-fine ladder filters by scale rank.
function isVisible(scaleRank: number, zoom: number): boolean {
  if (zoom >= 9) return true;
  if (scaleRank <= 1 && zoom >= 5) return true;
  if (scaleRank <= 3 && zoom >= 6) return true;
  if (scaleRank <= 4 && zoom >= 7) return true;
  if (scaleRank <= 5 && zoom >= 8) return true;
  return false;
}

/** Uniform font size at zoom >= 9 (CSS handles per-rank sizes below that). */
function uniformFontSizeForZoom(zoom: number): number {
  if (zoom >= 13) return 13;
  if (zoom >= 11) return 12;
  return 11;
}

const ALL_CITIES_ZOOM = 9;
/** Heavy add/remove of markers waits this long after the last zoom event. */
const ZOOM_SETTLE_MS = 250;

interface CityEntry {
  city: City;
  marker: L.Marker;
  shown: boolean;
}

export function useCitiesLayer({ mapRef }: UseCitiesLayerOptions): void {
  const { cities, layerVisibility } = useAppState();
  const layerRef = useRef<L.LayerGroup | null>(null);
  const entriesRef = useRef<CityEntry[]>([]);

  // Build all city markers ONCE per cities load. Markers without a parent
  // group don't have DOM yet, so this is cheap; DOM creation only happens
  // when each one is added to the on-map group below.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || cities.length === 0) return;

    const old = layerRef.current;
    if (old) map.removeLayer(old);

    const group = L.layerGroup();
    const entries: CityEntry[] = cities.map((city) => {
      const html = `<div class="city-label city-rank-${city.SCALERANK}">${city.NAME}</div>`;
      const icon = L.divIcon({ html, className: '', iconSize: undefined, iconAnchor: [0, 0] });
      const marker = L.marker([city.lat, city.lon], { icon, interactive: false, keyboard: false });
      return { city, marker, shown: false };
    });

    // Update font size styling immediately on every zoomend — this is just
    // a class swap and a CSS-var write on one DOM node, essentially free.
    const updateFontStyle = (): void => {
      const zoom = map.getZoom();
      const pane = map.getPane('markerPane');
      if (!pane) return;
      if (zoom >= ALL_CITIES_ZOOM) {
        pane.classList.remove('cities-low-zoom');
        pane.style.setProperty('--city-font', `${uniformFontSizeForZoom(zoom)}px`);
      } else {
        pane.classList.add('cities-low-zoom');
        pane.style.removeProperty('--city-font');
      }
    };

    // Add/remove markers crossing the visibility threshold. This is the
    // expensive pass — Leaflet has to create/destroy DOM for each crossing
    // marker. We DEBOUNCE it: rapid scroll-wheel zooms produce a flurry of
    // zoomend events, but we only want to do the DOM work once after the
    // user has stopped zooming.
    const updateVisibility = (): void => {
      const zoom = map.getZoom();
      for (const entry of entries) {
        const visible = isVisible(entry.city.SCALERANK, zoom);
        if (visible && !entry.shown) {
          group.addLayer(entry.marker);
          entry.shown = true;
        } else if (!visible && entry.shown) {
          group.removeLayer(entry.marker);
          entry.shown = false;
        }
      }
    };

    let settleTimeout: number | null = null;
    const onZoomEnd = (): void => {
      updateFontStyle();
      if (settleTimeout !== null) clearTimeout(settleTimeout);
      settleTimeout = window.setTimeout(() => {
        settleTimeout = null;
        updateVisibility();
      }, ZOOM_SETTLE_MS);
    };

    layerRef.current = group;
    entriesRef.current = entries;
    if (layerVisibility.cities) group.addTo(map);
    // Initial render — apply both immediately, no debounce on first paint.
    updateFontStyle();
    updateVisibility();
    map.on('zoomend', onZoomEnd);

    return () => {
      map.off('zoomend', onZoomEnd);
      if (settleTimeout !== null) clearTimeout(settleTimeout);
      map.removeLayer(group);
      layerRef.current = null;
      entriesRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapRef, cities]);

  // Honor toggle
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    if (layerVisibility.cities && !map.hasLayer(layer)) layer.addTo(map);
    else if (!layerVisibility.cities && map.hasLayer(layer)) map.removeLayer(layer);
  }, [mapRef, layerVisibility.cities]);
}
