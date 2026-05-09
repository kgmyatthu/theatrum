import { useEffect, useRef, type RefObject } from 'react';
import L from 'leaflet';

const ESRI_SAT_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

interface UseLeafletMapOptions {
  containerRef: RefObject<HTMLDivElement>;
  center?: [number, number];
  zoom?: number;
}

/**
 * Owns the Leaflet map instance. Returns a ref that holds it once initialized.
 * The ref will be null until first effect runs.
 */
export function useLeafletMap({
  containerRef,
  center = [45, 15],
  zoom = 4,
}: UseLeafletMapOptions): RefObject<L.Map | null> {
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (mapRef.current) return; // already initialized

    const map = L.map(container, {
      minZoom: 2,
      maxZoom: 19,
      worldCopyJump: true,
      preferCanvas: true,
      boxZoom: false,
    }).setView(center, zoom);

    L.tileLayer(ESRI_SAT_URL, {
      maxZoom: 19,
      attribution: '© Esri',
    }).addTo(map);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef]);

  return mapRef;
}
