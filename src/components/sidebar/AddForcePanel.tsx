import { useEffect, useState } from 'react';
import { useAppState } from '@/state/AppContext';
import { useForceDraft } from '@/state/ForceDraftContext';
import { Panel } from '@/components/ui/Panel';
import type { ForceBranch } from '@/types';
import styles from './NewCountryPanel.module.css';

interface AddForcePanelProps {
  onStatus: (msg: string) => void;
}

/**
 * Holds the new-force form. Form values mirror into a ref via ForceDraftContext
 * so MapView can read them when the user clicks the map in add-force mode.
 * This decouples form ownership from map-click handling.
 */
export function AddForcePanel({ onStatus }: AddForcePanelProps) {
  const { mode, owners, forces } = useAppState();
  const { draftRef } = useForceDraft();

  const [nation, setNation] = useState(owners[0] ?? '');
  const [branch, setBranch] = useState<ForceBranch>('army');
  const [name, setName] = useState('');
  const [strength, setStrength] = useState('40000');
  const [commander, setCommander] = useState('');

  // Keep nation valid if owners list shifts under us
  useEffect(() => {
    if (owners.length === 0) return;
    if (!owners.includes(nation)) setNation(owners[0]!);
  }, [owners, nation]);

  // Mirror form into draftRef whenever any field changes
  useEffect(() => {
    draftRef.current = {
      nation,
      branch,
      name: name.trim(),
      strength: parseInt(strength, 10) || 0,
      commander: commander.trim(),
    };
  }, [draftRef, nation, branch, name, strength, commander]);

  // Status hint when entering mode
  useEffect(() => {
    if (mode === 'add-force') {
      onStatus('Fill in the form, then click on the map to place the force.');
    }
  }, [mode, onStatus]);

  // Detect successful placement (forces.length grew) and clear form
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

  return (
    <Panel title="New Force">
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
      <label className={styles.label}>Commander</label>
      <input
        type="text"
        className={styles.input}
        value={commander}
        onChange={(e) => setCommander(e.target.value)}
      />
      <div className={styles.helper}>
        Click anywhere on the map to place the force.
      </div>
    </Panel>
  );
}
