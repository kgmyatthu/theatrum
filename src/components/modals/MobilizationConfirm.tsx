import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { haversineKm, formatDistance } from '@/utils/geometry';
import type { PendingMove } from '@/hooks/useForcesLayer';
import styles from './MobilizationConfirm.module.css';

interface MobilizationConfirmProps {
  pending: PendingMove;
  onConfirm: () => void;
  onCancel: () => void;
}

export function MobilizationConfirm({ pending, onConfirm, onCancel }: MobilizationConfirmProps) {
  const { force, origin, target } = pending;
  const km = haversineKm(origin.lat, origin.lon, target.lat, target.lon);

  // Esc cancels, Enter confirms
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onConfirm();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, onConfirm]);

  return (
    <div className={styles.backdrop} onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className={styles.panel}>
        <h3 className={styles.title}>Confirm {force.branch === 'navy' ? 'Naval' : 'Army'} Mobilization</h3>

        <div className={styles.row}>
          <span className={styles.key}>Unit</span>
          <span className={styles.value}>{force.name}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.key}>Nation</span>
          <span className={styles.value}>{force.nation}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.key}>From</span>
          <span className={styles.value}>
            {origin.lat.toFixed(2)}, {origin.lon.toFixed(2)}
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.key}>To</span>
          <span className={styles.value}>
            {target.lat.toFixed(2)}, {target.lon.toFixed(2)}
          </span>
        </div>

        <div className={styles.distance}>March: {formatDistance(km)}</div>

        <div className={styles.buttons}>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="success" onClick={onConfirm}>
            Confirm
          </Button>
        </div>
      </div>
    </div>
  );
}
