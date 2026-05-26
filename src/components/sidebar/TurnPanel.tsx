import { useState } from 'react';
import { useAppState } from '@/state/AppContext';
import { useAuth } from '@/auth/AuthContext';
import { Panel } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { ARMY_KM_PER_DAY, NAVY_KM_PER_DAY } from '@/utils/movement';
import { AdvanceTurnModal } from '@/components/modals/AdvanceTurnModal';

export function TurnPanel() {
  const { currentDate, lastTurnDays, turnNumber } = useAppState();
  const auth = useAuth();
  const isAdmin = auth.role === 'admin';
  const [modalOpen, setModalOpen] = useState(false);

  const armyBudget = ARMY_KM_PER_DAY * lastTurnDays;
  const navyBudget = NAVY_KM_PER_DAY * lastTurnDays;

  return (
    <Panel title="Turn">
      <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-muted)' }}>
        <div>
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Turn {turnNumber}</span>
          {' • '}
          <span style={{ fontFamily: 'var(--font-mono)' }}>{currentDate}</span>
        </div>
        <div>Last turn: {lastTurnDays} day{lastTurnDays === 1 ? '' : 's'}</div>
        <div style={{ fontSize: 11, marginTop: 4 }}>
          Army budget: <b style={{ color: 'var(--text-primary)' }}>{armyBudget} km</b>
          {' • '}
          Navy budget: <b style={{ color: 'var(--text-primary)' }}>{navyBudget} km</b>
        </div>
      </div>
      {isAdmin && (
        <div style={{ marginTop: 8 }}>
          <Button fullWidth variant="primary" onClick={() => setModalOpen(true)}>
            Advance Turn…
          </Button>
        </div>
      )}
      {modalOpen && <AdvanceTurnModal onClose={() => setModalOpen(false)} />}
    </Panel>
  );
}
