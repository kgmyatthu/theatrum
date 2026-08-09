import type { Action } from './actions';
import type { AppState } from './state';
import { initialState } from './state';
import type { Country, Force } from '@/types';
import { normalizeNation } from '@/utils/nation';
import { haversineKm } from '@/utils/geometry';
import { daysBetween } from '@/utils/movement';

function countriesToOwnersAndPalette(countries: Country[]): {
  owners: string[];
  palette: Record<string, string>;
} {
  const palette: Record<string, string> = {};
  const owners: string[] = [];
  for (const c of countries) {
    const name = normalizeNation(c.name);
    palette[name] = c.color;
    owners.push(name);
  }
  owners.sort();
  return { owners, palette };
}

function normalizeForce(f: Force): Force {
  const n = normalizeNation(f.nation);
  // Backfill turn-tracking fields for forces loaded from a pre-turn snapshot
  // (the v8 reset shipped without these; once everyone has a turn-aware
  // snapshot in their browser this branch is dead code).
  const needsTurnFields =
    typeof f.turnStartLon !== 'number' ||
    typeof f.turnStartLat !== 'number' ||
    typeof f.kmMovedThisTurn !== 'number';
  if (n === f.nation && !needsTurnFields) return f;
  return {
    ...f,
    nation: n,
    turnStartLon: typeof f.turnStartLon === 'number' ? f.turnStartLon : f.lon,
    turnStartLat: typeof f.turnStartLat === 'number' ? f.turnStartLat : f.lat,
    kmMovedThisTurn: typeof f.kmMovedThisTurn === 'number' ? f.kmMovedThisTurn : 0,
  };
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
      // Normalize so case drift in the source data file can't break key lookups.
      for (const [fid, owner] of snapshot.ownerships) {
        const feat = provinces.features[fid];
        if (feat) feat.properties.owner = normalizeNation(owner);
      }

      const { owners, palette } = countriesToOwnersAndPalette(snapshot.countries);

      return {
        ...state,
        loaded: true,
        provinces,
        cities,
        owners,
        palette,
        forces: (snapshot.forces ?? []).map(normalizeForce),
        currentDate: snapshot.currentDate ?? state.currentDate,
        lastTurnDays:
          typeof snapshot.lastTurnDays === 'number' ? snapshot.lastTurnDays : state.lastTurnDays,
        turnNumber:
          typeof snapshot.turnNumber === 'number' ? snapshot.turnNumber : state.turnNumber,
        provincesVersion: state.provincesVersion + 1,
        pendingRenames: [],
        pendingUserAdds: [],
        pendingUserRemoves: [],
      };
    }

    case 'SET_OWNER': {
      if (!state.provinces) return state;
      const { fids, owner } = action.payload;
      const fidSet = new Set(fids);
      const norm = normalizeNation(owner);
      // Mutate feature properties in place — accept this for performance
      // since the GeoJSON has 4,596 features and creating a new collection
      // each time would be wasteful. Components subscribing to ownership
      // changes use the `mutationCounter` increment via a separate hook.
      for (const f of state.provinces.features) {
        if (fidSet.has(f.properties._fid)) f.properties.owner = norm;
      }
      return { ...state, provincesVersion: state.provincesVersion + 1 };
    }

    case 'ADD_COUNTRY': {
      const { name, color } = action.payload;
      const norm = normalizeNation(name);
      if (!norm || state.owners.includes(norm)) return state;
      return {
        ...state,
        owners: [...state.owners, norm].sort(),
        palette: { ...state.palette, [norm]: color },
      };
    }

    case 'RENAME_COUNTRY': {
      const { oldName, newName } = action.payload;
      if (!state.provinces) return state;
      const oldN = normalizeNation(oldName);
      const newN = normalizeNation(newName);
      if (!newN || oldN === newN || state.owners.includes(newN)) return state;

      // Migrate provinces
      for (const f of state.provinces.features) {
        if (f.properties.owner === oldN) f.properties.owner = newN;
      }
      // Migrate forces
      const forces = state.forces.map((force) =>
        force.nation === oldN ? { ...force, nation: newN } : force,
      );
      // Migrate palette
      const newPalette: Record<string, string> = { ...state.palette };
      if (newPalette[oldN] !== undefined) {
        newPalette[newN] = newPalette[oldN]!;
        delete newPalette[oldN];
      }
      // Migrate owners list
      const owners = state.owners
        .filter((o) => o !== oldN)
        .concat(newN)
        .sort();
      return {
        ...state,
        owners,
        palette: newPalette,
        forces,
        provincesVersion: state.provincesVersion + 1,
        pendingRenames: [...state.pendingRenames, { from: oldN, to: newN }],
      };
    }

    case 'CHANGE_COUNTRY_COLOR': {
      const { name, color } = action.payload;
      const norm = normalizeNation(name);
      if (!state.owners.includes(norm)) return state;
      return {
        ...state,
        palette: { ...state.palette, [norm]: color },
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
        forces: [...state.forces, normalizeForce(action.payload.force)],
      };
    }

    case 'UPDATE_FORCE': {
      const { force } = action.payload;
      const norm = normalizeForce(force);
      return {
        ...state,
        forces: state.forces.map((f) => (f.id === norm.id ? norm : f)),
      };
    }

    case 'SPLIT_FORCE': {
      const { id, newId, name, strength } = action.payload;
      const parent = state.forces.find((f) => f.id === id);
      if (!parent) return state;
      const detached = Math.floor(strength);
      // Both halves must remain real forces — reject a split that would
      // zero out either side. UI gates this too; keep the reducer safe.
      if (!Number.isFinite(detached) || detached < 1 || detached >= parent.strength) {
        return state;
      }
      if (state.forces.some((f) => f.id === newId)) return state;
      // The detachment spawns at the parent's position and inherits the
      // turn-tracking fields verbatim: it has marched wherever the parent
      // marched this turn, so it keeps the same turnStart anchor, the
      // same spent budget, and the same raise-turn lock. Fresh values
      // here would conjure movement out of thin air (or dodge the
      // newly-raised lock by "splitting" a just-raised army).
      const detachment: Force = {
        ...parent,
        id: newId,
        name: name.trim() || `${parent.name} (detachment)`,
        strength: detached,
        commander: '',
      };
      return {
        ...state,
        forces: state.forces.flatMap((f) =>
          f.id === id ? [{ ...f, strength: f.strength - detached }, detachment] : [f],
        ),
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
        forces: state.forces.map((f) => {
          if (f.id !== id) return f;
          const stepKm = haversineKm(f.lat, f.lon, lat, lon);
          return {
            ...f,
            lat,
            lon,
            kmMovedThisTurn: f.kmMovedThisTurn + stepKm,
          };
        }),
      };
    }

    case 'ADVANCE_TURN': {
      const { newDate } = action.payload;
      const elapsed = daysBetween(state.currentDate, newDate);
      // Refuse non-forward moves silently — UI gates this, but keep the
      // reducer safe in case a bad dispatch slips through.
      if (elapsed <= 0) return state;
      return {
        ...state,
        currentDate: newDate,
        lastTurnDays: elapsed,
        turnNumber: state.turnNumber + 1,
        forces: state.forces.map((f) => ({
          ...f,
          turnStartLon: f.lon,
          turnStartLat: f.lat,
          kmMovedThisTurn: 0,
        })),
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
      // Apply ownerships, normalizing in case the snapshot was authored
      // before this contract or by a third-party tool.
      for (const [fid, owner] of snapshot.ownerships) {
        const feat = state.provinces.features[fid];
        if (feat) feat.properties.owner = normalizeNation(owner);
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
        forces: (snapshot.forces ?? []).map(normalizeForce),
        currentDate: snapshot.currentDate ?? state.currentDate,
        lastTurnDays:
          typeof snapshot.lastTurnDays === 'number' ? snapshot.lastTurnDays : state.lastTurnDays,
        turnNumber:
          typeof snapshot.turnNumber === 'number' ? snapshot.turnNumber : state.turnNumber,
        provincesVersion: state.provincesVersion + 1,
        pendingRenames: [],
        pendingUserAdds: [],
        pendingUserRemoves: [],
      };
    }

    case 'ADD_PENDING_USER': {
      const login = action.payload.login.trim();
      if (!login) return state;
      // Replace any existing entry for the same login so admin can fix typos
      // without growing the queue. Login compare is case-insensitive — GitHub
      // usernames are case-insensitive in practice.
      const filtered = state.pendingUserAdds.filter(
        (u) => u.login.toLowerCase() !== login.toLowerCase(),
      );
      const entry =
        action.payload.role === 'admin'
          ? { login, role: 'admin' as const }
          : (() => {
              const nation = normalizeNation(action.payload.nation);
              return nation ? { login, role: 'player' as const, nation } : null;
            })();
      if (!entry) return state;
      return { ...state, pendingUserAdds: [...filtered, entry] };
    }

    case 'REMOVE_PENDING_USER': {
      const login = action.payload.login.toLowerCase();
      return {
        ...state,
        pendingUserAdds: state.pendingUserAdds.filter(
          (u) => u.login.toLowerCase() !== login,
        ),
      };
    }

    case 'STAGE_USER_REMOVE': {
      const login = action.payload.login.trim();
      if (!login) return state;
      const lc = login.toLowerCase();
      if (state.pendingUserRemoves.some((l) => l.toLowerCase() === lc)) return state;
      return { ...state, pendingUserRemoves: [...state.pendingUserRemoves, login] };
    }

    case 'UNSTAGE_USER_REMOVE': {
      const lc = action.payload.login.toLowerCase();
      return {
        ...state,
        pendingUserRemoves: state.pendingUserRemoves.filter(
          (l) => l.toLowerCase() !== lc,
        ),
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
