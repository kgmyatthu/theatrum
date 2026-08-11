import { useEffect, useState } from 'react';
import { useAppDispatch, useAppState } from '@/state/AppContext';
import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/components/ui/Button';
import { mintForceId } from '@/utils/forceId';
import { hasMovedThisTurn } from '@/utils/movement';
import { getStateRefreshBaseline } from '@/hooks/useStateRefresh';
import type { Force, ForceBranch } from '@/types';
import styles from './ForceModal.module.css';

interface ForceModalProps {
  force: Force;
  onDismiss: () => void;
}

export function ForceModal({ force, onDismiss }: ForceModalProps) {
  const dispatch = useAppDispatch();
  const { owners } = useAppState();
  const auth = useAuth();

  const [name, setName] = useState(force.name);
  const [nation, setNation] = useState(force.nation);
  const [branch, setBranch] = useState<ForceBranch>(force.branch);
  const [strength, setStrength] = useState(String(force.strength));
  const [commander, setCommander] = useState(force.commander);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [splitName, setSplitName] = useState(`${force.name} (detachment)`);
  const [splitStrength, setSplitStrength] = useState(
    String(Math.floor(force.strength / 2)),
  );

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

  // A force marches once per turn, so a confirmed march is normally final —
  // but only from the moment it lands on main, which is where the server
  // pins the force back. Until then it is a local edit like any other and
  // may be taken back. The refresh baseline IS main as this client last saw
  // it, so ask that rather than guessing: unsubmitted march → offer the
  // recall; already merged → the button is gone and the drag stays locked.
  const canRecall =
    hasMovedThisTurn(force) &&
    !(getStateRefreshBaseline()?.forces ?? []).some(
      (f) => f.id === force.id && hasMovedThisTurn(f),
    );

  const handleRecall = (): void => {
    dispatch({ type: 'RECALL_FORCE', payload: { id: force.id } });
    onDismiss();
  };

  // This modal is only reachable via the forces layer's `editable` gate
  // (admin, or player right-clicking their own force), so auth.login is
  // set in practice; the 'local' fallback is type-narrowing safety only.
  const parsedSplit = parseInt(splitStrength, 10);
  const splitValid =
    Number.isFinite(parsedSplit) && parsedSplit >= 1 && parsedSplit < force.strength;

  const handleConfirmSplit = (): void => {
    if (!splitValid) return;
    dispatch({
      type: 'SPLIT_FORCE',
      payload: {
        id: force.id,
        newId: mintForceId(auth.login ?? 'local'),
        name: splitName,
        strength: parsedSplit,
      },
    });
    onDismiss();
  };

  const strengthLabel = branch === 'navy' ? 'Fleet size (ships)' : 'Strength (men)';
  const splitUnit = force.branch === 'navy' ? 'ships' : 'men';

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

        {splitting ? (
          <>
            <label className={styles.label}>Detachment name</label>
            <input
              className={styles.input}
              type="text"
              value={splitName}
              onChange={(e) => setSplitName(e.target.value)}
            />

            <label className={styles.label}>
              Detachment {splitUnit} (of {force.strength})
            </label>
            <input
              className={styles.input}
              type="number"
              min={1}
              max={force.strength - 1}
              value={splitStrength}
              onChange={(e) => setSplitStrength(e.target.value)}
            />

            <div className={styles.buttons}>
              <span className={styles.confirmText}>
                {splitValid
                  ? `${force.name} keeps ${force.strength - parsedSplit} ${splitUnit}. The detachment inherits this turn's march, so it can only move if ${force.name} has not.`
                  : `Enter 1–${force.strength - 1}.`}
              </span>
              <div className={styles.right}>
                <Button onClick={() => setSplitting(false)}>Cancel</Button>
                <Button variant="primary" disabled={!splitValid} onClick={handleConfirmSplit}>
                  Confirm Split
                </Button>
              </div>
            </div>
          </>
        ) : confirmingDelete ? (
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
              {force.strength > 1 && (
                <Button onClick={() => setSplitting(true)}>Split…</Button>
              )}
              {canRecall && <Button onClick={handleRecall}>Recall march</Button>}
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
