import type { Action } from './actions';
import type { AppState } from './state';
import { initialState } from './state';

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'BOOTSTRAP_DATA': {
      const { provinces, cities, palette, owners, forces, nextForceId } = action.payload;
      // Tag features with stable _fid (mutates feature objects — they're never compared by ref later)
      provinces.features.forEach((f, i) => {
        f.properties._fid = i;
      });
      return {
        ...state,
        loaded: true,
        provinces,
        cities,
        palette,
        owners: [...owners].sort(),
        builtinOwners: new Set(owners),
        originalPalette: { ...palette },
        forces,
        nextForceId,
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
      // Owner sort isn't affected; just return new state shell so React re-renders.
      return { ...state };
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
      // Track built-in removal
      const wasBuiltin = state.builtinOwners.has(oldName);
      const newBuiltins = new Set(state.builtinOwners);
      const newRemoved = new Set(state.removedBuiltins);
      if (wasBuiltin) {
        newBuiltins.delete(oldName);
        newBuiltins.add(newName);
        newRemoved.add(oldName);
      }
      return {
        ...state,
        owners,
        palette: newPalette,
        forces,
        builtinOwners: newBuiltins,
        removedBuiltins: newRemoved,
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
      // Apply removed builtins
      const newRemoved = new Set(state.removedBuiltins);
      const newBuiltins = new Set(state.builtinOwners);
      let owners = [...state.owners];
      let palette: Record<string, string> = { ...state.palette };

      for (const removedName of snapshot.removedBuiltins ?? []) {
        newRemoved.add(removedName);
        newBuiltins.delete(removedName);
        owners = owners.filter((o) => o !== removedName);
        delete palette[removedName];
      }
      // Apply custom countries
      for (const cc of snapshot.customCountries ?? []) {
        if (!owners.includes(cc.name)) owners.push(cc.name);
        palette[cc.name] = cc.color;
      }
      owners.sort();
      // Apply ownerships
      for (const [fid, owner] of snapshot.ownerships) {
        const feat = state.provinces.features[fid];
        if (feat) feat.properties.owner = owner;
      }
      return {
        ...state,
        owners,
        palette,
        builtinOwners: newBuiltins,
        removedBuiltins: newRemoved,
        forces: snapshot.forces ?? [],
        nextForceId: snapshot.nextForceId ?? 1,
        provinceFillOpacity:
          typeof snapshot.provinceFillOpacity === 'number'
            ? snapshot.provinceFillOpacity
            : state.provinceFillOpacity,
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
