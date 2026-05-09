import { createContext, useContext, useMemo, useRef, type ReactNode, type MutableRefObject } from 'react';
import type { ForceBranch } from '@/types';

export interface ForceDraft {
  nation: string;
  branch: ForceBranch;
  name: string;
  strength: number;
  commander: string;
}

interface ForceDraftContextValue {
  /**
   * Mutable ref holding the latest values from the AddForcePanel form.
   * MapView reads `current` when the user clicks in add-force mode.
   * A ref is used (not state) because the map click handler shouldn't
   * trigger re-renders of the form when the form's own values change.
   */
  draftRef: MutableRefObject<ForceDraft | null>;
}

const ForceDraftContext = createContext<ForceDraftContextValue | undefined>(undefined);

export function ForceDraftProvider({ children }: { children: ReactNode }) {
  const draftRef = useRef<ForceDraft | null>(null);
  const value = useMemo<ForceDraftContextValue>(() => ({ draftRef }), []);
  return <ForceDraftContext.Provider value={value}>{children}</ForceDraftContext.Provider>;
}

export function useForceDraft(): ForceDraftContextValue {
  const ctx = useContext(ForceDraftContext);
  if (!ctx) throw new Error('useForceDraft must be used within ForceDraftProvider');
  return ctx;
}
