import { useEffect, useState } from 'react';
import { useAppDispatch, useAppState } from '@/state/AppContext';
import { Button } from '@/components/ui/Button';
import type { Force, ForceBranch } from '@/types';
import styles from './ForceModal.module.css';

interface ForceModalProps {
  force: Force;
  onDismiss: () => void;
}

export function ForceModal({ force, onDismiss }: ForceModalProps) {
  const dispatch = useAppDispatch();
  const { owners } = useAppState();

  const [name, setName] = useState(force.name);
  const [nation, setNation] = useState(force.nation);
  const [branch, setBranch] = useState<ForceBranch>(force.branch);
  const [strength, setStrength] = useState(String(force.strength));
  const [commander, setCommander] = useState(force.commander);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const handleSave = (): void => {
    const updated: Force = {
      ...force,
      name: name.trim() || force.name,
      nation,
      branch,
      strength: parseInt(strength, 10) || 0,
      commander: commander.trim(),
    };
    dispatch({ type: 'UPDATE_FORCE', payload: { force: updated } });
    onDismiss();
  };

  const handleConfirmDelete = (): void => {
    dispatch({ type: 'DELETE_FORCE', payload: { id: force.id } });
    onDismiss();
  };

  const strengthLabel = branch === 'navy' ? 'Fleet size (ships)' : 'Strength (men)';

  return (
    <div className={styles.backdrop} onClick={(e) => e.target === e.currentTarget && onDismiss()}>
      <div className={styles.panel}>
        <h3 className={styles.title}>Edit: {force.name}</h3>

        <label className={styles.label}>Name</label>
        <input
          className={styles.input}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label className={styles.label}>Nation</label>
        <select
          className={styles.input}
          value={nation}
          onChange={(e) => setNation(e.target.value)}
        >
          {owners.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>

        <label className={styles.label}>Branch</label>
        <select
          className={styles.input}
          value={branch}
          onChange={(e) => setBranch(e.target.value as ForceBranch)}
        >
          <option value="army">Army (cross)</option>
          <option value="navy">Navy (anchor)</option>
        </select>

        <label className={styles.label}>{strengthLabel}</label>
        <input
          className={styles.input}
          type="number"
          value={strength}
          onChange={(e) => setStrength(e.target.value)}
        />

        <label className={styles.label}>Commander</label>
        <input
          className={styles.input}
          type="text"
          value={commander}
          onChange={(e) => setCommander(e.target.value)}
        />

        {confirmingDelete ? (
          <div className={styles.buttons}>
            <span className={styles.confirmText}>
              Delete &ldquo;{force.name}&rdquo;?
            </span>
            <div className={styles.right}>
              <Button onClick={() => setConfirmingDelete(false)}>Cancel</Button>
              <Button variant="danger" onClick={handleConfirmDelete}>
                Confirm Delete
              </Button>
            </div>
          </div>
        ) : (
          <div className={styles.buttons}>
            <div className={styles.left}>
              <Button variant="danger" onClick={() => setConfirmingDelete(true)}>
                Delete
              </Button>
            </div>
            <div className={styles.right}>
              <Button onClick={onDismiss}>Cancel</Button>
              <Button variant="primary" onClick={handleSave}>
                Save
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
