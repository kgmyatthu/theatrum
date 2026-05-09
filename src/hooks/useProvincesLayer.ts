import { useEffect, useRef, type RefObject } from 'react';
import L from 'leaflet';
import type { ProvinceFeature } from '@/types';
import { useAppState } from '@/state/AppContext';

interface UseProvincesLayerOptions {
  mapRef: RefObject<L.Map | null>;
  onProvinceClick: (feature: ProvinceFeature, ev: L.LeafletMouseEvent) => void;
  onProvinceContextMenu: (feature: ProvinceFeature, ev: L.LeafletMouseEvent) => void;
  onProvinceHover: (feature: ProvinceFeature) => void;
  onProvinceMouseOut: () => void;
}

const STYLE_DEFAULT_BORDER = { color: '#222', weight: 0.4, opacity: 0.85 };
const STYLE_SELECTED_BORDER = { color: '#ffeb3b', weight: 2.5, opacity: 1 };

/**
 * Province borders need a hairline at world view but a wider stroke when
 * zoomed in: the source GeoJSON has adjacent provinces whose shared edges
 * are *almost but not exactly* identical (floating-point differences), and
 * at deep zoom those sub-degree mismatches project to visible pixel gaps.
 * A wider stroke from both sides overlaps and hides them.
 */
function borderWeightForZoom(zoom: number): number {
  if (zoom <= 4) return 0.4;
  if (zoom >= 12) return 1.6;
  return 0.4 + ((zoom - 4) / 8) * 1.2;
}

/**
 * Renders the provinces GeoJSON onto the map. Subscribes to state changes
 * to restyle features when ownership, palette, opacity, or selection changes.
 */
export function useProvincesLayer({
  mapRef,
  onProvinceClick,
  onProvinceContextMenu,
  onProvinceHover,
  onProvinceMouseOut,
}: UseProvincesLayerOptions): void {
  const state = useAppState();
  const layerRef = useRef<L.GeoJSON | null>(null);
  const layersByFid = useRef<Map<number, L.Layer>>(new Map());

  // Hold the latest handlers in a ref so the bound listeners always read
  // current state — the layer is only built once, so capturing the props
  // by closure would freeze them at first bind.
  const handlersRef = useRef({ onProvinceClick, onProvinceContextMenu, onProvinceHover, onProvinceMouseOut });
  handlersRef.current = { onProvinceClick, onProvinceContextMenu, onProvinceHover, onProvinceMouseOut };

  // Build the layer once on bootstrap
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !state.provinces || layerRef.current) return;

    const layer = L.geoJSON(state.provinces as GeoJSON.FeatureCollection, {
      style: () => ({
        ...STYLE_DEFAULT_BORDER,
        fillColor: '#888',
        fillOpacity: state.provinceFillOpacity,
        // smoothFactor=0 disables Leaflet's per-zoom path simplification.
        // Adjacent provinces share exact border vertices in the source data;
        // any simplification can drop different vertices on each side and
        // produce hairline gaps when zoomed in. Pay the extra render cost
        // to keep borders meeting cleanly.
        smoothFactor: 0,
      }),
      onEachFeature: (feature, lyr) => {
        const f = feature as ProvinceFeature;
        layersByFid.current.set(f.properties._fid, lyr);
        lyr.on('click', (e) => handlersRef.current.onProvinceClick(f, e as L.LeafletMouseEvent));
        lyr.on('contextmenu', (e) => handlersRef.current.onProvinceContextMenu(f, e as L.LeafletMouseEvent));
        lyr.on('mouseover', () => handlersRef.current.onProvinceHover(f));
        lyr.on('mouseout', () => handlersRef.current.onProvinceMouseOut());
      },
    });

    if (state.layerVisibility.provinces) layer.addTo(map);
    layerRef.current = layer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapRef, state.provinces]);

  // Restyle whenever palette, ownership, opacity, selection, or zoom changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !state.provinces) return;

    const apply = (): void => {
      const baseWeight = borderWeightForZoom(map.getZoom());
      // Selected border stays prominent — scale alongside the base weight
      // but never go below the original 2.5 so selection remains obvious.
      const selWeight = Math.max(2.5, baseWeight * 4);
      for (const feat of state.provinces!.features) {
        const lyr = layersByFid.current.get(feat.properties._fid);
        if (!lyr) continue;
        const sel = state.selectedFids.has(feat.properties._fid);
        const border = sel
          ? { ...STYLE_SELECTED_BORDER, weight: selWeight }
          : { ...STYLE_DEFAULT_BORDER, weight: baseWeight };
        const fillColor = state.palette[feat.properties.owner] ?? '#888888';
        (lyr as L.Path).setStyle({
          ...border,
          fillColor,
          fillOpacity: state.provinceFillOpacity,
        });
      }
    };

    // Restyling all 4596 features is expensive — debounce on zoom so a
    // burst of zoom events (scroll-wheel zoom) only triggers it once after
    // the user has stopped. State changes (palette/selection/opacity) still
    // restyle immediately since those are user-driven and need feedback.
    apply();
    let settleTimeout: number | null = null;
    const onZoomEnd = (): void => {
      if (settleTimeout !== null) clearTimeout(settleTimeout);
      settleTimeout = window.setTimeout(() => {
        settleTimeout = null;
        apply();
      }, 250);
    };
    map.on('zoomend', onZoomEnd);
    return () => {
      map.off('zoomend', onZoomEnd);
      if (settleTimeout !== null) clearTimeout(settleTimeout);
    };
  }, [
    mapRef,
    state.provinces,
    state.palette,
    state.provinceFillOpacity,
    state.selectedFids,
  ]);

  // Show / hide based on visibility
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    if (state.layerVisibility.provinces && !map.hasLayer(layer)) layer.addTo(map);
    else if (!state.layerVisibility.provinces && map.hasLayer(layer)) map.removeLayer(layer);
  }, [mapRef, state.layerVisibility.provinces]);
}
