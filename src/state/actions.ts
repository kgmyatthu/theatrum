import type { AppSnapshot, City, Force, Palette, ProvinceCollection } from '@/types';

export type Action =
  | {
      type: 'BOOTSTRAP_DATA';
      payload: {
        provinces: ProvinceCollection;
        cities: City[];
        palette: Palette;
        owners: string[];
        forces: Force[];
        nextForceId: number;
      };
    }
  | { type: 'SET_OWNER'; payload: { fids: number[]; owner: string } }
  | { type: 'ADD_COUNTRY'; payload: { name: string; color: string } }
  | { type: 'RENAME_COUNTRY'; payload: { oldName: string; newName: string } }
  | { type: 'CHANGE_COUNTRY_COLOR'; payload: { name: string; color: string } }
  | { type: 'SET_OPACITY'; payload: { opacity: number } }
  | { type: 'ADD_FORCE'; payload: { force: Force } }
  | { type: 'UPDATE_FORCE'; payload: { force: Force } }
  | { type: 'DELETE_FORCE'; payload: { id: number } }
  | { type: 'MOVE_FORCE'; payload: { id: number; lat: number; lon: number } }
  | { type: 'TOGGLE_LAYER'; payload: { layer: 'provinces' | 'countryLabels' | 'cities' | 'forces' } }
  | { type: 'SET_MODE'; payload: { mode: 'view' | 'add-force' | 'ruler' } }
  | { type: 'SELECT_PROVINCES'; payload: { fids: number[]; mode: 'set' | 'add' | 'toggle' | 'clear' } }
  | { type: 'APPLY_SNAPSHOT'; payload: { snapshot: AppSnapshot } }
  | { type: 'RESET' };
