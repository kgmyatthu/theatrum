import { useEffect, useState } from 'react';
import { useAppState } from '@/state/AppContext';
import { useForceDraft } from '@/state/ForceDraftContext';
import { useAuth } from '@/auth/AuthContext';
import { Panel } from '@/components/ui/Panel';
import { raiseBudget, raiseCost, standingArmyCeiling } from '@/utils/movement';
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
  const { mode, owners, forces, lastTurnDays, populationByNation } = useAppState();
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
  // Population arrives as a SCALAR off the turn state — deliberately no
  // province scan here. Everything below the early return above re-runs on
  // every keystroke in the strength box, and a 4,596-feature sum per
  // keystroke is a cost a text input can't carry. The table was summed
  // once already, at the ADVANCE_TURN that anchored it.
  //
  // The two-step resolve mirrors checkRaiseBudgets line for line, because
  // the whole job of this panel is to predict what that gate will answer:
  // no table at all → undefined → the flat cap and no ceiling (fail open on
  // absence); a table that simply doesn't list this nation → 0 → the 3,000
  // floor on both figures (fail closed on contents). The tempting
  // `populationByNation?.[nation]` collapses those two into one and would
  // promise a stateless nation 15,000 men a month.
  const pop =
    populationByNation === undefined ? undefined : (populationByNation[nation] ?? 0);
  const cap = raiseBudget(branch, lastTurnDays, pop);
  // Bucketed by CURRENT branch, matching checkRaiseBudgets: a force re-branded
  // this turn bills the pool it moved into, which is the pool shown here.
  const spent = forces
    .filter((f) => f.nation === nation && f.branch === branch)
    .reduce((sum, f) => sum + raiseCost(f), 0);
  const remaining = Math.max(0, cap - spent);
  // The second limit: a stock, not a flow. Men already under arms, again
  // bucketed by current branch — the same set the gate sums.
  const ceiling = standingArmyCeiling(pop);
  const standing = forces
    .filter((f) => f.nation === nation && f.branch === 'army')
    .reduce((sum, f) => sum + f.strength, 0);
  // Two reasons not to render the ceiling, folded into one test: the navy
  // has none at all, and an absent population makes it Infinity (the
  // spelling of "unenforced"), which is not a number to show a player.
  const showCeiling = branch === 'army' && Number.isFinite(ceiling);
  // Over the ceiling, the gate refuses ANY army spend — it is tested
  // before the monthly cap and takes precedence over it — so the headroom
  // figure below would be a lie. Say the true rule instead: nothing can be
  // raised until the standing army comes down. Losing provinces can put a
  // nation here having done nothing, so this is a state to explain, not an
  // error to scold about.
  const overCeiling = showCeiling && standing > ceiling;
  const n = (v: number): string => v.toLocaleString();

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
        ) : overCeiling ? (
          <>
            Standing army {n(standing)} / {n(ceiling)} men — more than your population
            supports, so <b>no {unit} can be raised</b> until it is cut back.
          </>
        ) : (
          <>
            Recruitment: {n(spent)} / {n(cap)} {unit} this month
            {showCeiling ? (
              <>
                {' '}
                · {n(standing)} / {n(ceiling)} total
              </>
            ) : null}{' '}
            — <b>{n(remaining)} {unit}</b> left.
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
