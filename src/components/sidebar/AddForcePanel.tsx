import { useEffect, useState } from 'react';
import { useAppState } from '@/state/AppContext';
import { useForceDraft } from '@/state/ForceDraftContext';
import { useAuth } from '@/auth/AuthContext';
import { Panel } from '@/components/ui/Panel';
import { raiseBudget, raiseCost } from '@/utils/movement';
import type { ForceBranch } from '@/types';
import styles from './NewCountryPanel.module.css';

interface AddForcePanelProps {
  onStatus: (msg: string) => void;
}

/**
 * Holds the new-force form. Form values mirror into a ref via ForceDraftContext
 * so MapView can read them when the user clicks the map in add-force mode.
 *
 * For a player (role === 'player'), the nation field is locked to their
 * assigned nation. Admins can pick any nation.
 */
export function AddForcePanel({ onStatus }: AddForcePanelProps) {
  const { mode, owners, forces, lastTurnDays } = useAppState();
  const { draftRef } = useForceDraft();
  const auth = useAuth();
  const lockedNation = auth.role === 'player' ? auth.nation : null;

  const [nation, setNation] = useState(lockedNation ?? owners[0] ?? '');
  const [branch, setBranch] = useState<ForceBranch>('army');
  const [name, setName] = useState('');
  const [strength, setStrength] = useState('40000');
  const [commander, setCommander] = useState('');

  // Keep nation valid: player → locked to their nation; admin → first owner if current is missing.
  useEffect(() => {
    if (lockedNation) {
      if (nation !== lockedNation) setNation(lockedNation);
      return;
    }
    if (owners.length === 0) return;
    if (!owners.includes(nation)) setNation(owners[0]!);
  }, [owners, nation, lockedNation]);

  // Mirror form into draftRef
  useEffect(() => {
    draftRef.current = {
      nation,
      branch,
      name: name.trim(),
      strength: parseInt(strength, 10) || 0,
      commander: commander.trim(),
    };
  }, [draftRef, nation, branch, name, strength, commander]);

  useEffect(() => {
    if (mode === 'add-force') {
      onStatus('Fill in the form, then click on the map to place the force.');
    }
  }, [mode, onStatus]);

  const [lastSeenCount, setLastSeenCount] = useState(forces.length);
  useEffect(() => {
    if (forces.length > lastSeenCount) {
      setName('');
      setLastSeenCount(forces.length);
      onStatus('Force placed. Edit the form to place another, or change mode.');
    } else if (forces.length !== lastSeenCount) {
      setLastSeenCount(forces.length);
    }
  }, [forces.length, lastSeenCount, onStatus]);

  if (mode !== 'add-force') return null;

  const strengthLabel = branch === 'navy' ? 'Fleet size (ships)' : 'Strength (men)';

  // Recruitment headroom, same sums the worker runs on submit: cap for the
  // branch minus what this nation already raised or reinforced this turn.
  // Read-only preview — the worker is the real gate, so we don't disable
  // anything here, we just tell the player what will bounce.
  const unit = branch === 'navy' ? 'ships' : 'men';
  const cap = raiseBudget(branch, lastTurnDays);
  // Bucketed by CURRENT branch, matching checkRaiseBudgets: a force re-branded
  // this turn bills the pool it moved into, which is the pool shown here.
  const spent = forces
    .filter((f) => f.nation === nation && f.branch === branch)
    .reduce((sum, f) => sum + raiseCost(f), 0);
  const remaining = Math.max(0, cap - spent);

  return (
    <Panel title="New Force">
      <label className={styles.label}>Nation</label>
      {lockedNation ? (
        <input
          className={styles.input}
          value={lockedNation}
          readOnly
          style={{ opacity: 0.7, cursor: 'not-allowed', textTransform: 'uppercase' }}
        />
      ) : (
        <select
          className={styles.input}
          value={nation}
          onChange={(e) => setNation(e.target.value)}
          style={{ textTransform: 'uppercase' }}
        >
          {owners.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )}
      <label className={styles.label}>Branch</label>
      <select
        className={styles.input}
        value={branch}
        onChange={(e) => setBranch(e.target.value as ForceBranch)}
      >
        <option value="army">Army (cross)</option>
        <option value="navy">Navy (anchor)</option>
      </select>
      <label className={styles.label}>Name</label>
      <input
        type="text"
        className={styles.input}
        placeholder="e.g. I Corps"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <label className={styles.label}>{strengthLabel}</label>
      <input
        type="number"
        className={styles.input}
        value={strength}
        onChange={(e) => setStrength(e.target.value)}
      />
      <div className={styles.helper}>
        {cap === 0 ? (
          <>
            Turn is only {Math.max(0, lastTurnDays)} days — shorter than a month, so no {unit} can
            be raised or reinforced.
          </>
        ) : (
          <>
            Recruitment this turn: {spent} / {cap} {unit} — <b>{remaining} {unit}</b> left.
          </>
        )}
      </div>
      <label className={styles.label}>Commander</label>
      <input
        type="text"
        className={styles.input}
        value={commander}
        onChange={(e) => setCommander(e.target.value)}
      />
      <div className={styles.helper}>Click anywhere on the map to place the force.</div>
    </Panel>
  );
}
