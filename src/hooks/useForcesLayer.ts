import { useEffect, useRef, type RefObject } from 'react';
import L from 'leaflet';
import type { Force } from '@/types';
import { useAppState } from '@/state/AppContext';
import { haversineKm, formatDistance } from '@/utils/geometry';

export interface PendingMove {
  force: Force;
  origin: { lat: number; lon: number };
  target: { lat: number; lon: number };
  /** Called by parent on confirm or cancel — controls the marker. */
  marker: L.Marker;
}

interface UseForcesLayerOptions {
  mapRef: RefObject<L.Map | null>;
  onForceContextMenu: (force: Force) => void;
  /** Called when a drag ends — parent shows confirmation popup. */
  onForceDragEnd: (move: PendingMove) => void;
}

function formatStrength(s: number, branch: Force['branch']): string {
  if (branch === 'navy') {
    return s === 1 ? '1 ship' : `${s} ships`;
  }
  if (s >= 1_000_000) return `${(s / 1_000_000).toFixed(1)}M`;
  if (s >= 1000) return `${Math.round(s / 1000)}k`;
  return String(s);
}

function makeForceIcon(force: Force, color: string): L.DivIcon {
  const branchClass = force.branch === 'navy' ? 'navy' : 'army';
  const html = `<div class="force-counter ${branchClass}" style="background:${color}">
    <div class="force-nation-above">${force.nation}</div>
    <div class="force-name-below">${force.name}</div>
    <div class="force-strength-below">${formatStrength(force.strength, force.branch)}</div>
  </div>`;
  return L.divIcon({ html, className: '', iconSize: undefined, iconAnchor: [0, 0] });
}

interface DragArtifacts {
  origin: L.LatLng;
  line: L.Polyline;
  distanceLabel: L.Marker;
}

export function useForcesLayer({
  mapRef,
  onForceContextMenu,
  onForceDragEnd,
}: UseForcesLayerOptions): void {
  const { forces, palette, layerVisibility } = useAppState();
  const layerRef = useRef<L.LayerGroup | null>(null);

  // Rebuild markers when forces or palette changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const old = layerRef.current;
    if (old) map.removeLayer(old);
    const group = L.layerGroup();

    // Per-marker drag artifacts (line + distance label)
    const artifacts = new Map<number, DragArtifacts>();

    for (const force of forces) {
      const color = palette[force.nation] ?? '#888';
      const marker = L.marker([force.lat, force.lon], {
        icon: makeForceIcon(force, color),
        draggable: true,
        title: `${force.name} (${force.nation})`,
      });

      marker.on('dragstart', () => {
        const origin = L.latLng(force.lat, force.lon);
        const line = L.polyline([origin, origin], {
          color: '#ffeb3b',
          weight: 2,
          opacity: 0.95,
          dashArray: '4 6',
          interactive: false,
        }).addTo(group);
        const distanceLabel = L.marker(origin, {
          icon: L.divIcon({
            html: `<div class="force-drag-distance">0 km</div>`,
            className: '',
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          }),
          interactive: false,
          keyboard: false,
        }).addTo(group);
        artifacts.set(force.id, { origin, line, distanceLabel });
      });

      marker.on('drag', (ev) => {
        const cur = (ev.target as L.Marker).getLatLng();
        const art = artifacts.get(force.id);
        if (!art) return;
        art.line.setLatLngs([art.origin, cur]);
        const km = haversineKm(art.origin.lat, art.origin.lng, cur.lat, cur.lng);
        const mid = L.latLng((art.origin.lat + cur.lat) / 2, (art.origin.lng + cur.lng) / 2);
        art.distanceLabel.setLatLng(mid);
        art.distanceLabel.setIcon(
          L.divIcon({
            html: `<div class="force-drag-distance">${formatDistance(km)}</div>`,
            className: '',
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          }),
        );
      });

      marker.on('dragend', () => {
        const cur = marker.getLatLng();
        const art = artifacts.get(force.id);
        if (!art) return;
        // Remove the drag artifacts; parent decides whether to commit the move
        group.removeLayer(art.line);
        group.removeLayer(art.distanceLabel);
        artifacts.delete(force.id);
        onForceDragEnd({
          force,
          origin: { lat: art.origin.lat, lon: art.origin.lng },
          target: { lat: cur.lat, lon: cur.lng },
          marker,
        });
      });

      marker.on('contextmenu', (ev) => {
        const e = ev as L.LeafletMouseEvent;
        e.originalEvent.preventDefault();
        e.originalEvent.stopPropagation();
        onForceContextMenu(force);
      });

      marker.addTo(group);
    }
    layerRef.current = group;
    if (layerVisibility.forces) group.addTo(map);
  }, [mapRef, forces, palette, layerVisibility.forces, onForceContextMenu, onForceDragEnd]);

  // Honor toggle
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    if (layerVisibility.forces && !map.hasLayer(layer)) layer.addTo(map);
    else if (!layerVisibility.forces && map.hasLayer(layer)) map.removeLayer(layer);
  }, [mapRef, layerVisibility.forces]);
}
