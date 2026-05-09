import { useEffect, useRef, type RefObject } from 'react';
import L from 'leaflet';
import { useAppState } from '@/state/AppContext';

interface UseCitiesLayerOptions {
  mapRef: RefObject<L.Map | null>;
}

interface CityVisibility {
  show: boolean;
  fontSize: number;
}

function visibilityForCity(scaleRank: number, zoom: number): CityVisibility {
  if (zoom >= 10) {
    const fontSize = zoom >= 13 ? 11 : zoom >= 11 ? 10 : 9;
    return { show: true, fontSize };
  }
  if (scaleRank <= 1 && zoom >= 5) return { show: true, fontSize: 12 };
  if (scaleRank <= 3 && zoom >= 6) return { show: true, fontSize: 11 };
  if (scaleRank <= 4 && zoom >= 7) return { show: true, fontSize: 10 };
  if (scaleRank <= 5 && zoom >= 8) return { show: true, fontSize: 10 };
  if (scaleRank <= 6 && zoom >= 9) return { show: true, fontSize: 9 };
  return { show: false, fontSize: 0 };
}

export function useCitiesLayer({ mapRef }: UseCitiesLayerOptions): void {
  const { cities, layerVisibility } = useAppState();
  const layerRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || cities.length === 0) return;

    const renderLabels = (): void => {
      const old = layerRef.current;
      if (old) map.removeLayer(old);
      const group = L.layerGroup();
      const zoom = map.getZoom();
      for (const city of cities) {
        const { show, fontSize } = visibilityForCity(city.SCALERANK, zoom);
        if (!show) continue;
        const html = `<div class="city-label" style="font-size:${fontSize}px">${city.NAME}</div>`;
        const icon = L.divIcon({ html, className: '', iconSize: undefined, iconAnchor: [0, 0] });
        L.marker([city.lat, city.lon], { icon, interactive: false, keyboard: false }).addTo(group);
      }
      layerRef.current = group;
      if (layerVisibility.cities) group.addTo(map);
    };

    renderLabels();
    map.on('zoomend', renderLabels);
    return () => {
      map.off('zoomend', renderLabels);
      const layer = layerRef.current;
      if (layer) {
        map.removeLayer(layer);
        layerRef.current = null;
      }
    };
  }, [mapRef, cities, layerVisibility.cities]);

  // Honor toggle
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    if (layerVisibility.cities && !map.hasLayer(layer)) layer.addTo(map);
    else if (!layerVisibility.cities && map.hasLayer(layer)) map.removeLayer(layer);
  }, [mapRef, layerVisibility.cities]);
}
