import { useEffect, useRef, type RefObject } from 'react';
import L from 'leaflet';
import { useAppDispatch, useAppState } from '@/state/AppContext';
import { useAuth } from '@/auth/AuthContext';
import { computeBBox } from '@/utils/geometry';
import type { BBox } from '@/types';

interface UseDragSelectOptions {
  mapRef: RefObject<L.Map | null>;
}

interface DragState {
  startContainer: L.Point;
  startLatLng: L.LatLng;
  rectEl: HTMLDivElement;
}

/**
 * Shift+drag on the map to select all provinces whose bbox intersects the
 * dragged rectangle. Holding shift while dragging suppresses Leaflet's
 * default boxZoom (we already disabled it in useLeafletMap).
 *
 * The rectangle is rendered as a plain absolutely-positioned div in screen
 * pixels — simpler than an L.rectangle since we want a fixed-pixel overlay
 * rather than a geographic shape.
 */
export function useDragSelect({ mapRef }: UseDragSelectOptions): void {
  const { provinces } = useAppState();
  const dispatch = useAppDispatch();
  const auth = useAuth();
  const isAdmin = auth.role === 'admin';
  const dragRef = useRef<DragState | null>(null);
  const bboxCacheRef = useRef<Map<number, BBox> | null>(null);

  // Build bbox cache once per provinces collection
  useEffect(() => {
    if (!provinces) {
      bboxCacheRef.current = null;
      return;
    }
    const cache = new Map<number, BBox>();
    for (const f of provinces.features) {
      cache.set(f.properties._fid, computeBBox(f.geometry));
    }
    bboxCacheRef.current = cache;
  }, [provinces]);

  useEffect(() => {
    const map = mapRef.current;
    // Multi-select is admin-only; bail out for everyone else.
    if (!map || !isAdmin) return;

    const container = map.getContainer();

    const onMouseDown = (ev: MouseEvent): void => {
      // Only shift+left-click on the map background starts a drag-select
      if (!ev.shiftKey || ev.button !== 0) return;
      // Ignore drags that begin on a div icon (force counter, label, etc.)
      const target = ev.target as HTMLElement;
      if (target.closest('.leaflet-marker-icon')) return;

      ev.preventDefault();
      ev.stopPropagation();

      const containerPt = map.mouseEventToContainerPoint(ev);
      const latlng = map.containerPointToLatLng(containerPt);

      const rectEl = document.createElement('div');
      rectEl.className = 'drag-select-rect';
      container.appendChild(rectEl);

      dragRef.current = { startContainer: containerPt, startLatLng: latlng, rectEl };
      // Disable map dragging during the select
      map.dragging.disable();
    };

    const onMouseMove = (ev: MouseEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      const cur = map.mouseEventToContainerPoint(ev);
      const x1 = Math.min(drag.startContainer.x, cur.x);
      const y1 = Math.min(drag.startContainer.y, cur.y);
      const x2 = Math.max(drag.startContainer.x, cur.x);
      const y2 = Math.max(drag.startContainer.y, cur.y);
      drag.rectEl.style.left = `${x1}px`;
      drag.rectEl.style.top = `${y1}px`;
      drag.rectEl.style.width = `${x2 - x1}px`;
      drag.rectEl.style.height = `${y2 - y1}px`;
    };

    const onMouseUp = (ev: MouseEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      const cur = map.mouseEventToContainerPoint(ev);
      const endLatLng = map.containerPointToLatLng(cur);

      // Compute selection bbox in geographic coords
      const minLon = Math.min(drag.startLatLng.lng, endLatLng.lng);
      const maxLon = Math.max(drag.startLatLng.lng, endLatLng.lng);
      const minLat = Math.min(drag.startLatLng.lat, endLatLng.lat);
      const maxLat = Math.max(drag.startLatLng.lat, endLatLng.lat);

      // Discard tiny accidental drags
      const dxPx = Math.abs(drag.startContainer.x - cur.x);
      const dyPx = Math.abs(drag.startContainer.y - cur.y);
      const isClick = dxPx < 4 && dyPx < 4;

      // Cleanup before dispatching
      drag.rectEl.remove();
      dragRef.current = null;
      map.dragging.enable();

      if (isClick) return;

      const cache = bboxCacheRef.current;
      if (!cache || !provinces) return;

      const selected: number[] = [];
      for (const feature of provinces.features) {
        const bb = cache.get(feature.properties._fid);
        if (!bb) continue;
        // Intersection test: any overlap counts
        if (
          bb.maxLon < minLon ||
          bb.minLon > maxLon ||
          bb.maxLat < minLat ||
          bb.minLat > maxLat
        ) {
          continue;
        }
        selected.push(feature.properties._fid);
      }

      const mode = ev.shiftKey ? 'add' : 'set';
      dispatch({
        type: 'SELECT_PROVINCES',
        payload: { fids: selected, mode },
      });
    };

    container.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return () => {
      container.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      const drag = dragRef.current;
      if (drag) {
        drag.rectEl.remove();
        dragRef.current = null;
        map.dragging.enable();
      }
    };
  }, [mapRef, provinces, dispatch, isAdmin]);
}
