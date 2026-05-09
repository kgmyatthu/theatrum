# Theatrum — React + TypeScript

Interactive historical mapping app. React 18 + strict TypeScript + Vite + Leaflet.
Feature-complete port of the original single-file HTML version.

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production bundle (~102 KB gzipped JS)
npm run lint     # type-check only
```

## Architecture

```
src/
├── types/index.ts                 Domain types (Province, Force, City, Snapshot…)
├── state/
│   ├── AppContext.tsx             Provider + useAppState/useAppDispatch hooks
│   ├── ForceDraftContext.tsx      Ref-based bridge from form to map click
│   ├── actions.ts                 Discriminated-union Action type
│   ├── reducer.ts                 Pure reducer (exhaustiveness-checked)
│   └── state.ts                   AppState shape + initialState
├── hooks/
│   ├── useDataBootstrap.ts        Fetches static data, dispatches BOOTSTRAP_DATA
│   ├── useLeafletMap.ts           Owns the L.Map instance
│   ├── useProvincesLayer.ts       Renders provinces, restyles on state changes
│   ├── useCitiesLayer.ts          Zoom-dependent city labels
│   ├── useCountryLabelsLayer.ts   Connected-component country labels
│   ├── useForcesLayer.ts          Force counters with drag-with-confirm
│   ├── useRulerTool.ts            Click-to-measure great-circle distances
│   ├── useAddForceClick.ts        Map click → ADD_FORCE in add-force mode
│   └── useDragSelect.ts           Shift+drag rectangle multi-select
├── utils/
│   ├── geometry.ts                BBox, Haversine, set helpers
│   ├── connectedComponents.ts     Union-find over shared vertices
│   ├── snapshot.ts                JSON serialization helpers
│   └── svgExport.ts               SVG export with embedded snapshot, import parse
├── components/
│   ├── App.tsx
│   ├── ui/                        Reusable: Button, Panel, ColorPicker
│   ├── sidebar/                   Mode, AddForce, NewCountry, EditCountry,
│   │                              Display, Layers, Persistence, Stats
│   ├── map/                       MapView, ContextMenu, ProvinceInfo,
│   │                              CSS modules for ForceCounter, Ruler, DragSelect
│   └── modals/                    ForceModal (edit), MobilizationConfirm
├── index.css                      Design tokens + global resets
└── main.tsx                       Entry — composes providers
```

### Key patterns

**Strict typing.** `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noUncheckedIndexedAccess`. Index access on arrays returns `T | undefined`. The reducer's switch is exhaustively type-checked via `_exhaustive: never`.

**Discriminated-union actions.** Every state mutation is a typed `Action` variant. Adding a new action without handling it in the reducer is a compile-time error.

**Component reuse.** `Button` (variants: default / primary / success / danger; flags: active, fullWidth), `Panel` (title + children), `ColorPicker` (combined hex + native picker, syncs both directions). Sidebar panels are pure compositions.

**CSS modules.** Each component imports a sibling `.module.css`. Locally scoped, no collisions. Design tokens in `src/index.css` as CSS variables. Global selectors via `:global(...)` only where Leaflet renders divIcons outside React (country labels, city labels, force counters, ruler, drag-select rectangle).

**Imperative bridge.** Leaflet is imperative; React is declarative. Custom hooks own the imperative lifecycle:
- `useLeafletMap` initializes/destroys the map.
- Layer hooks own a layer ref and resync when state changes.
- Tool hooks (`useRulerTool`, `useAddForceClick`, `useDragSelect`) attach/detach handlers based on mode.

**Form-to-map bridge.** `ForceDraftContext` exposes a `MutableRefObject<ForceDraft | null>`. The form mirrors values via `useEffect`; the map click handler reads `current` without re-rendering the form.

**Drag-with-confirm.** `useForcesLayer` raises `onForceDragEnd` with a `PendingMove` object that includes the marker reference. The parent shows `MobilizationConfirm`. On confirm: dispatch `MOVE_FORCE`. On cancel: `marker.setLatLng(origin)` to snap back — the underlying force never changed coordinates so no redux roundtrip is needed.

## Features (full parity with HTML version)

**Province interactions**
- Esri Satellite basemap, 4596 historical provinces with reactive restyling
- Hover info overlay (province name, modern country, current owner with swatch)
- Shift+click toggle into multi-select; **Shift+drag rectangle** for multi-select
- Right-click province → searchable country menu (with color swatches)
- Multi-select right-click bulk reassigns all selected provinces

**Map layers**
- Country labels: one per connected landmass, font scaled to area
- Cities: zoom-dependent, all 7,342 visible at zoom ≥ 10
- Layer toggles: provinces / country labels / cities / forces

**Forces**
- Army (X cross) / navy (anchor) counters with nation, name, strength
- **Drag with confirmation**: dotted line shows route during drag, modal asks Confirm/Cancel with march distance, snaps back on cancel
- Right-click counter to edit (name, nation, branch, strength, commander, delete)
- Add Force mode: form in sidebar, click on map to place at coordinates

**Tools**
- Ruler: click points, double-click to finish, Esc to cancel; per-segment + cumulative Haversine distance

**Country management**
- Add new country (name + color picker)
- Rename (cascades to provinces, forces, palette)
- Change color
- Opacity slider 0–100% (default 50%)

**Persistence**
- Save / Load to localStorage
- Reset (clears storage and reloads)
- Export / Import JSON snapshot
- **Export / Import SVG** with embedded snapshot in `<metadata>` CDATA — the SVG is both a viewable image and a re-importable save file

**Stats**
- Top 10 nations by province count

## Status

- ✅ `tsc --noEmit` zero errors under strict mode
- ✅ `vite build` succeeds — 82 modules, 333 KB JS (102 KB gzipped), 7.5 KB CSS
- ✅ Feature-complete with the original HTML version

## Data

In `public/data/`:
- `provinces.geojson` — 4,596 provinces (~5 MB)
- `cities.json` — 7,342 world cities
- `palette.json` — 66 nation colors
- `owners.json` — sorted nation list
- `seed_forces.json` — example army/navy units
