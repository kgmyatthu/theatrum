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
  | { type: 'DELETE_FORCE'; payload: { id: string } }
  | { type: 'MOVE_FORCE'; payload: { id: string; lat: number; lon: number } }
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
