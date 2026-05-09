import { useCallback, useEffect, useRef, useState } from 'react';
import type L from 'leaflet';
import { useLeafletMap } from '@/hooks/useLeafletMap';
import { useProvincesLayer } from '@/hooks/useProvincesLayer';
import { useCitiesLayer } from '@/hooks/useCitiesLayer';
import { useCountryLabelsLayer } from '@/hooks/useCountryLabelsLayer';
import { useForcesLayer, type PendingMove } from '@/hooks/useForcesLayer';
import { useRulerTool } from '@/hooks/useRulerTool';
import { useAddForceClick } from '@/hooks/useAddForceClick';
import { useDragSelect } from '@/hooks/useDragSelect';
import { useAppDispatch, useAppState } from '@/state/AppContext';
import type { Force, ProvinceFeature } from '@/types';
import { ContextMenu, type ContextMenuPosition } from './ContextMenu';
import { ProvinceInfo } from './ProvinceInfo';
import { ForceModal } from '@/components/modals/ForceModal';
import { MobilizationConfirm } from '@/components/modals/MobilizationConfirm';
import styles from './Map.module.css';
import './ForceCounter.module.css';
import './Ruler.module.css';
import './DragSelect.module.css';

interface ContextMenuState {
  position: ContextMenuPosition;
  fids: number[];
}

interface HoverState {
  feature: ProvinceFeature;
}

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useLeafletMap({ containerRef });
  const dispatch = useAppDispatch();
  const { mode, selectedFids } = useAppState();

  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [editingForce, setEditingForce] = useState<Force | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);

  const handleProvinceClick = useCallback(
    (feature: ProvinceFeature, ev: L.LeafletMouseEvent): void => {
      const { _fid } = feature.properties;
      if (ev.originalEvent.shiftKey) {
        dispatch({ type: 'SELECT_PROVINCES', payload: { fids: [_fid], mode: 'toggle' } });
      } else if (mode === 'view') {
        if (selectedFids.size > 0) {
          dispatch({ type: 'SELECT_PROVINCES', payload: { fids: [], mode: 'clear' } });
        }
      }
      ev.originalEvent.stopPropagation();
    },
    [dispatch, mode, selectedFids],
  );

  const handleProvinceContextMenu = useCallback(
    (feature: ProvinceFeature, ev: L.LeafletMouseEvent): void => {
      ev.originalEvent.preventDefault();
      ev.originalEvent.stopPropagation();
      const { _fid } = feature.properties;
      const fids = selectedFids.has(_fid) ? Array.from(selectedFids) : [_fid];
      setMenu({
        position: { x: ev.originalEvent.pageX, y: ev.originalEvent.pageY },
        fids,
      });
    },
    [selectedFids],
  );

  const handleProvinceHover = useCallback((feature: ProvinceFeature): void => {
    setHover({ feature });
  }, []);

  const handleProvinceMouseOut = useCallback((): void => {
    setHover(null);
  }, []);

  useProvincesLayer({
    mapRef,
    onProvinceClick: handleProvinceClick,
    onProvinceContextMenu: handleProvinceContextMenu,
    onProvinceHover: handleProvinceHover,
    onProvinceMouseOut: handleProvinceMouseOut,
  });

  useCitiesLayer({ mapRef });
  useCountryLabelsLayer({ mapRef });
  useRulerTool({ mapRef });
  useAddForceClick({ mapRef });
  useDragSelect({ mapRef });

  // Left-click on the map background (ocean / no province under cursor)
  // deselects all provinces. Clicks on a province go through
  // handleProvinceClick — Leaflet's canvas renderer suppresses the map
  // click in that case, so this only fires on truly empty areas.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const handler = (e: L.LeafletMouseEvent): void => {
      if (e.originalEvent.shiftKey) return;
      if (mode !== 'view') return;
      if (selectedFids.size === 0) return;
      dispatch({ type: 'SELECT_PROVINCES', payload: { fids: [], mode: 'clear' } });
    };
    map.on('click', handler);
    return () => {
      map.off('click', handler);
    };
  }, [mapRef, mode, selectedFids, dispatch]);

  const handleForceContextMenu = useCallback((force: Force): void => {
    setEditingForce(force);
  }, []);

  const handleForceDragEnd = useCallback((move: PendingMove): void => {
    setPendingMove(move);
  }, []);

  useForcesLayer({
    mapRef,
    onForceContextMenu: handleForceContextMenu,
    onForceDragEnd: handleForceDragEnd,
  });

  const handleMenuPick = useCallback(
    (owner: string): void => {
      if (!menu) return;
      dispatch({ type: 'SET_OWNER', payload: { fids: menu.fids, owner } });
      dispatch({ type: 'SELECT_PROVINCES', payload: { fids: [], mode: 'clear' } });
      setMenu(null);
    },
    [dispatch, menu],
  );

  const handleMobilizationConfirm = useCallback((): void => {
    if (!pendingMove) return;
    dispatch({
      type: 'MOVE_FORCE',
      payload: {
        id: pendingMove.force.id,
        lat: pendingMove.target.lat,
        lon: pendingMove.target.lon,
      },
    });
    setPendingMove(null);
  }, [dispatch, pendingMove]);

  const handleMobilizationCancel = useCallback((): void => {
    if (!pendingMove) return;
    // Snap marker back to origin — the underlying force.lat/lon never changed
    pendingMove.marker.setLatLng([pendingMove.origin.lat, pendingMove.origin.lon]);
    setPendingMove(null);
  }, [pendingMove]);

  return (
    <div className={styles.mapContainer}>
      <div ref={containerRef} className={styles.mapInner} />
      {hover && <ProvinceInfo feature={hover.feature} />}
      {menu && (
        <ContextMenu
          position={menu.position}
          selectedCount={menu.fids.length}
          onPick={handleMenuPick}
          onDismiss={() => setMenu(null)}
        />
      )}
      {editingForce && (
        <ForceModal force={editingForce} onDismiss={() => setEditingForce(null)} />
      )}
      {pendingMove && (
        <MobilizationConfirm
          pending={pendingMove}
          onConfirm={handleMobilizationConfirm}
          onCancel={handleMobilizationCancel}
        />
      )}
    </div>
  );
}
