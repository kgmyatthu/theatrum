import { useEffect, useRef, type RefObject } from 'react';
import L from 'leaflet';
import type { City } from '@/types';
import { useAppState } from '@/state/AppContext';

interface UseCitiesLayerOptions {
  mapRef: RefObject<L.Map | null>;
}

function isVisible(scaleRank: number, zoom: number): boolean {
  if (zoom >= 10) return true;
  if (scaleRank <= 1 && zoom >= 5) return true;
  if (scaleRank <= 3 && zoom >= 6) return true;
  if (scaleRank <= 4 && zoom >= 7) return true;
  if (scaleRank <= 5 && zoom >= 8) return true;
  if (scaleRank <= 6 && zoom >= 9) return true;
  return false;
}

/** Uniform font size at zoom >= 10 (CSS handles per-rank sizes at lower zoom). */
function uniformFontSizeForZoom(zoom: number): number {
  if (zoom >= 13) return 13;
  if (zoom >= 11) return 12;
  return 11;
}

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

    // On zoom: add/remove markers crossing the visibility threshold, then
    // update the marker-pane class/CSS-var to drive font size for the entire
    // layer at once. CSS rules (.cities-low-zoom .city-rank-N) handle the
    // per-rank ladder; --city-font handles the uniform size at zoom >= 10.
    const update = (): void => {
      const zoom = map.getZoom();
      const pane = map.getPane('markerPane');
      if (pane) {
        if (zoom >= 10) {
          pane.classList.remove('cities-low-zoom');
          pane.style.setProperty('--city-font', `${uniformFontSizeForZoom(zoom)}px`);
        } else {
          pane.classList.add('cities-low-zoom');
          pane.style.removeProperty('--city-font');
        }
      }
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

    layerRef.current = group;
    entriesRef.current = entries;
    if (layerVisibility.cities) group.addTo(map);
    update();
    map.on('zoomend', update);

    return () => {
      map.off('zoomend', update);
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
