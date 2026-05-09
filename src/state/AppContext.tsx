import { createContext, useContext, useReducer, type ReactNode, type Dispatch } from 'react';
import type { Action } from './actions';
import type { AppState } from './state';
import { initialState } from './state';
import { reducer } from './reducer';

interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<Action>;
}

const AppContext = createContext<AppContextValue | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  return <AppContext.Provider value={{ state, dispatch }}>{children}</AppContext.Provider>;
}

export function useAppState(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppState must be used within AppProvider');
  return ctx.state;
}

export function useAppDispatch(): Dispatch<Action> {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppDispatch must be used within AppProvider');
  return ctx.dispatch;
}
