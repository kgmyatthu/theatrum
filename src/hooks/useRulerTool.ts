import { useEffect, useRef, type RefObject } from 'react';
import L from 'leaflet';
import { useAppDispatch, useAppState } from '@/state/AppContext';
import { haversineKm, formatDistance } from '@/utils/geometry';

interface UseRulerToolOptions {
  mapRef: RefObject<L.Map | null>;
}

/**
 * Imperative ruler implementation. Activates when state.mode === 'ruler'.
 * Click adds a point, double-click finishes (still leaves it on map until
 * mode is exited), Escape clears.
 */
export function useRulerTool({ mapRef }: UseRulerToolOptions): void {
  const { mode } = useAppState();
  const dispatch = useAppDispatch();

  // All ruler artifacts live in this group so cleanup is a single removeLayer
  const groupRef = useRef<L.LayerGroup | null>(null);
  const pointsRef = useRef<L.LatLng[]>([]);
  const finishedRef = useRef(false);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (mode !== 'ruler') {
      // Tear down on exit
      if (groupRef.current) {
        map.removeLayer(groupRef.current);
        groupRef.current = null;
      }
      pointsRef.current = [];
      finishedRef.current = false;
      return;
    }

    const group = L.layerGroup().addTo(map);
    groupRef.current = group;
    pointsRef.current = [];
    finishedRef.current = false;

    const redraw = (): void => {
      group.clearLayers();
      const points = pointsRef.current;
      if (points.length === 0) return;

      // Draw markers
      for (const p of points) {
        L.circleMarker(p, {
          radius: 4,
          color: '#ffeb3b',
          fillColor: '#ffeb3b',
          fillOpacity: 1,
          weight: 1,
          interactive: false,
        }).addTo(group);
      }

      if (points.length < 2) return;

      // Polyline (dotted yellow)
      L.polyline(points, {
        color: '#ffeb3b',
        weight: 2,
        opacity: 0.95,
        dashArray: '4 6',
        interactive: false,
      }).addTo(group);

      // Per-segment + cumulative distance labels
      let cumKm = 0;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!;
        const b = points[i]!;
        const km = haversineKm(a.lat, a.lng, b.lat, b.lng);
        cumKm += km;
        const mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
        const label = `<div class="ruler-segment">${formatDistance(km)}</div>`;
        L.marker(mid, {
          icon: L.divIcon({ html: label, className: '', iconSize: [0, 0], iconAnchor: [0, 0] }),
          interactive: false,
          keyboard: false,
        }).addTo(group);
      }

      // Total at last point
      const last = points[points.length - 1]!;
      const total = `<div class="ruler-total">Σ ${formatDistance(cumKm)}</div>`;
      L.marker(last, {
        icon: L.divIcon({ html: total, className: '', iconSize: [0, 0], iconAnchor: [0, 0] }),
        interactive: false,
        keyboard: false,
      }).addTo(group);
    };

    const onClick = (e: L.LeafletMouseEvent): void => {
      if (finishedRef.current) {
        // Restart after a finished measurement
        pointsRef.current = [];
        finishedRef.current = false;
      }
      pointsRef.current.push(e.latlng);
      redraw();
    };

    const onDblClick = (e: L.LeafletMouseEvent): void => {
      // Prevent the default Leaflet zoom-in on double-click
      e.originalEvent.preventDefault();
      finishedRef.current = true;
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        pointsRef.current = [];
        finishedRef.current = false;
        redraw();
        // Exit ruler mode entirely
        dispatch({ type: 'SET_MODE', payload: { mode: 'view' } });
      }
    };

    map.on('click', onClick);
    map.on('dblclick', onDblClick);
    map.doubleClickZoom.disable();
    document.addEventListener('keydown', onKey);

    return () => {
      map.off('click', onClick);
      map.off('dblclick', onDblClick);
      map.doubleClickZoom.enable();
      document.removeEventListener('keydown', onKey);
      if (groupRef.current) {
        map.removeLayer(groupRef.current);
        groupRef.current = null;
      }
    };
  }, [mapRef, mode, dispatch]);
}
