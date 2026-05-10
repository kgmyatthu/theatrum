import type { Action } from './actions';
import type { AppState } from './state';
import { initialState } from './state';
import type { Country } from '@/types';

function countriesToOwnersAndPalette(countries: Country[]): {
  owners: string[];
  palette: Record<string, string>;
} {
  const palette: Record<string, string> = {};
  const owners: string[] = [];
  for (const c of countries) {
    palette[c.name] = c.color;
    owners.push(c.name);
  }
  owners.sort();
  return { owners, palette };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'BOOTSTRAP_DATA': {
      const { provinces, cities, snapshot } = action.payload;
      // Tag features with stable _fid (mutates feature objects — they're never compared by ref later)
      provinces.features.forEach((f, i) => {
        f.properties._fid = i;
      });

      // Apply ownership overrides — by _fid (== array index after the tag pass above).
      for (const [fid, owner] of snapshot.ownerships) {
        const feat = provinces.features[fid];
        if (feat) feat.properties.owner = owner;
      }

      const { owners, palette } = countriesToOwnersAndPalette(snapshot.countries);

      return {
        ...state,
        loaded: true,
        provinces,
        cities,
        owners,
        palette,
        forces: snapshot.forces ?? [],
        nextForceId: snapshot.nextForceId ?? 1,
        provincesVersion: state.provincesVersion + 1,
      };
    }

    case 'SET_OWNER': {
      if (!state.provinces) return state;
      const { fids, owner } = action.payload;
      const fidSet = new Set(fids);
      // Mutate feature properties in place — accept this for performance
      // since the GeoJSON has 4,596 features and creating a new collection
      // each time would be wasteful. Components subscribing to ownership
      // changes use the `mutationCounter` increment via a separate hook.
      for (const f of state.provinces.features) {
        if (fidSet.has(f.properties._fid)) f.properties.owner = owner;
      }
      return { ...state, provincesVersion: state.provincesVersion + 1 };
    }

    case 'ADD_COUNTRY': {
      const { name, color } = action.payload;
      if (state.owners.includes(name)) return state;
      return {
        ...state,
        owners: [...state.owners, name].sort(),
        palette: { ...state.palette, [name]: color },
      };
    }

    case 'RENAME_COUNTRY': {
      const { oldName, newName } = action.payload;
      if (!state.provinces) return state;
      if (oldName === newName || state.owners.includes(newName)) return state;

      // Migrate provinces
      for (const f of state.provinces.features) {
        if (f.properties.owner === oldName) f.properties.owner = newName;
      }
      // Migrate forces
      const forces = state.forces.map((force) =>
        force.nation === oldName ? { ...force, nation: newName } : force,
      );
      // Migrate palette
      const newPalette: Record<string, string> = { ...state.palette };
      if (newPalette[oldName] !== undefined) {
        newPalette[newName] = newPalette[oldName]!;
        delete newPalette[oldName];
      }
      // Migrate owners list
      const owners = state.owners
        .filter((o) => o !== oldName)
        .concat(newName)
        .sort();
      return {
        ...state,
        owners,
        palette: newPalette,
        forces,
        provincesVersion: state.provincesVersion + 1,
      };
    }

    case 'CHANGE_COUNTRY_COLOR': {
      const { name, color } = action.payload;
      if (!state.owners.includes(name)) return state;
      return {
        ...state,
        palette: { ...state.palette, [name]: color },
      };
    }

    case 'SET_OPACITY': {
      return { ...state, provinceFillOpacity: action.payload.opacity };
    }

    case 'SET_ICON_SCALE': {
      return { ...state, iconScale: action.payload.scale };
    }

    case 'ADD_FORCE': {
      return {
        ...state,
        forces: [...state.forces, action.payload.force],
        nextForceId: state.nextForceId + 1,
      };
    }

    case 'UPDATE_FORCE': {
      const { force } = action.payload;
      return {
        ...state,
        forces: state.forces.map((f) => (f.id === force.id ? force : f)),
      };
    }

    case 'DELETE_FORCE': {
      const { id } = action.payload;
      return {
        ...state,
        forces: state.forces.filter((f) => f.id !== id),
      };
    }

    case 'MOVE_FORCE': {
      const { id, lat, lon } = action.payload;
      return {
        ...state,
        forces: state.forces.map((f) => (f.id === id ? { ...f, lat, lon } : f)),
      };
    }

    case 'TOGGLE_LAYER': {
      const { layer } = action.payload;
      return {
        ...state,
        layerVisibility: {
          ...state.layerVisibility,
          [layer]: !state.layerVisibility[layer],
        },
      };
    }

    case 'SET_MODE': {
      return { ...state, mode: action.payload.mode };
    }

    case 'SELECT_PROVINCES': {
      const { fids, mode } = action.payload;
      const next = new Set(state.selectedFids);
      if (mode === 'set') {
        return { ...state, selectedFids: new Set(fids) };
      }
      if (mode === 'clear') {
        return { ...state, selectedFids: new Set() };
      }
      if (mode === 'add') {
        for (const fid of fids) next.add(fid);
      }
      if (mode === 'toggle') {
        for (const fid of fids) {
          if (next.has(fid)) next.delete(fid);
          else next.add(fid);
        }
      }
      return { ...state, selectedFids: next };
    }

    case 'APPLY_SNAPSHOT': {
      if (!state.provinces) return state;
      const { snapshot } = action.payload;
      // Apply ownerships
      for (const [fid, owner] of snapshot.ownerships) {
        const feat = state.provinces.features[fid];
        if (feat) feat.properties.owner = owner;
      }
      // Pre-v4 snapshots stored only diffs (customCountries / removedBuiltins)
      // against a built-in baseline that no longer exists. Fall back to the
      // current state's country list rather than crash; the user can still
      // recover ownership, forces, and opacity from the snapshot.
      const { owners, palette } = Array.isArray(snapshot.countries)
        ? countriesToOwnersAndPalette(snapshot.countries)
        : { owners: state.owners, palette: { ...state.palette } };
      return {
        ...state,
        owners,
        palette,
        forces: snapshot.forces ?? [],
        nextForceId: snapshot.nextForceId ?? 1,
        provincesVersion: state.provincesVersion + 1,
      };
    }

    case 'RESET': {
      return initialState;
    }

    default: {
      // Exhaustiveness check — TypeScript will error if a new action type isn't handled
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}
