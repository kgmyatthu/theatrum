import type { AppSnapshot, City, Force, ProvinceCollection } from '@/types';

export type Action =
  | {
      type: 'BOOTSTRAP_DATA';
      payload: {
        provinces: ProvinceCollection;
        cities: City[];
        snapshot: AppSnapshot;
      };
    }
  | { type: 'SET_OWNER'; payload: { fids: number[]; owner: string } }
  | { type: 'ADD_COUNTRY'; payload: { name: string; color: string } }
  | { type: 'RENAME_COUNTRY'; payload: { oldName: string; newName: string } }
  | { type: 'CHANGE_COUNTRY_COLOR'; payload: { name: string; color: string } }
  | { type: 'SET_OPACITY'; payload: { opacity: number } }
  | { type: 'SET_ICON_SCALE'; payload: { scale: number } }
  | { type: 'ADD_FORCE'; payload: { force: Force } }
  | { type: 'UPDATE_FORCE'; payload: { force: Force } }
  /**
   * Split `strength` off force `id` into a new sibling force `newId`.
   * The detachment inherits the parent's position and every turn-tracking
   * field (turnStart*, kmMovedThisTurn, createdAtTurn) — see the reducer
   * for why anything fresher would mint free movement.
   */
  | {
      type: 'SPLIT_FORCE';
      payload: { id: string; newId: string; name: string; strength: number };
    }
  /**
   * Fold `sourceId` into `targetId`: the source is consumed, the survivor
   * keeps the target's id and position and takes the WORST turn-tracking
   * state of the two, so merging can never buy movement. Only offered for
   * two forces of the same nation and branch.
   */
  | { type: 'MERGE_FORCE'; payload: { sourceId: string; targetId: string } }
  | { type: 'DELETE_FORCE'; payload: { id: string } }
  | { type: 'MOVE_FORCE'; payload: { id: string; lat: number; lon: number } }
  /**
   * Undo this turn's march: back to the turn-start anchor, odometer to 0.
   * Local only — once the march is on main the server pins the force where
   * main has it and refuses the unwind, so the UI offers this only while
   * the march is still unsubmitted.
   */
  | { type: 'RECALL_FORCE'; payload: { id: string } }
  | { type: 'ADVANCE_TURN'; payload: { newDate: string } }
  | { type: 'TOGGLE_LAYER'; payload: { layer: 'provinces' | 'countryLabels' | 'cities' | 'forces' } }
  | { type: 'SET_MODE'; payload: { mode: 'view' | 'add-force' | 'ruler' } }
  | { type: 'SELECT_PROVINCES'; payload: { fids: number[]; mode: 'set' | 'add' | 'toggle' | 'clear' } }
  | { type: 'APPLY_SNAPSHOT'; payload: { snapshot: AppSnapshot } }
  | {
      type: 'ADD_PENDING_USER';
      payload:
        | { login: string; role: 'player'; nation: string }
        | { login: string; role: 'admin' };
    }
  | { type: 'REMOVE_PENDING_USER'; payload: { login: string } }
  | { type: 'STAGE_USER_REMOVE'; payload: { login: string } }
  | { type: 'UNSTAGE_USER_REMOVE'; payload: { login: string } }
  | { type: 'RESET' };
