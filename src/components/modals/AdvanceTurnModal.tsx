import { useEffect, useState } from 'react';
import { useAppDispatch, useAppState } from '@/state/AppContext';
import { Button } from '@/components/ui/Button';
import { daysBetween, ARMY_KM_PER_DAY, NAVY_KM_PER_DAY } from '@/utils/movement';
import styles from './MobilizationConfirm.module.css';

interface AdvanceTurnModalProps {
  onClose: () => void;
}

/** Add an integer number of days to an ISO YYYY-MM-DD date. */
function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Admin-only modal — advances the in-game date, snaps every force's
 *  turn-start position, and zeroes the per-force movement counter. The
 *  resulting state still has to be submitted via the existing Submit Move
 *  flow; this dialog only updates the local buffer. */
export function AdvanceTurnModal({ onClose }: AdvanceTurnModalProps) {
  const dispatch = useAppDispatch();
  const { currentDate, turnNumber } = useAppState();

  // Default to +30 days — matches the seeded starter turn length, so the
  // most common case ("step forward a month") is one click.
  const [newDate, setNewDate] = useState<string>(() => addDays(currentDate, 30));

  const elapsed = daysBetween(currentDate, newDate);
  const valid = elapsed > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'Enter' && valid) confirm();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valid, newDate]);

  function confirm(): void {
    if (!valid) return;
    dispatch({ type: 'ADVANCE_TURN', payload: { newDate } });
    onClose();
  }

  return (
    <div className={styles.backdrop} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.panel}>
        <h3 className={styles.title}>Advance Turn</h3>

        <div className={styles.row}>
          <span className={styles.key}>Current</span>
          <span className={styles.value}>
            Turn {turnNumber} • {currentDate}
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.key}>New date</span>
          <span className={styles.value}>
            <input
              type="date"
              value={newDate}
              min={addDays(currentDate, 1)}
              onChange={(e) => setNewDate(e.target.value)}
              style={{
                background: 'var(--bg-panel)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
                padding: '2px 4px',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
              }}
            />
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.key}>Elapsed</span>
          <span className={styles.value}>
            {valid ? `+ ${elapsed} day${elapsed === 1 ? '' : 's'}` : 'pick a later date'}
          </span>
        </div>

        <div className={styles.distance}>
          New budgets: army {ARMY_KM_PER_DAY * Math.max(elapsed, 0)} km · navy{' '}
          {NAVY_KM_PER_DAY * Math.max(elapsed, 0)} km
        </div>

        <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0 0' }}>
          Confirming resets every force's per-turn movement budget to the new total. The change is
          local until you Submit Move.
        </p>

        <div className={styles.buttons}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="success" disabled={!valid} onClick={confirm}>
            Advance
          </Button>
        </div>
      </div>
    </div>
  );
}
