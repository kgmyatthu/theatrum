import { useEffect, useState } from 'react';
import { useAppDispatch, useAppState } from '@/state/AppContext';
import { Panel } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { normalizeNation } from '@/utils/nation';
import { fetchLiveData } from '@/utils/liveData';
import styles from './NewCountryPanel.module.css';

interface UsersPanelProps {
  onStatus: (msg: string) => void;
}

interface PermEntry {
  role: 'admin' | 'player';
  nation?: string;
}
type PermFile = Record<string, PermEntry>;

type RoleChoice = 'player' | 'admin';

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  margin: '2px 0',
  color: 'var(--text-primary)',
};

const xButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--text-muted)',
  fontSize: 11,
  lineHeight: 1,
  padding: '1px 6px',
  borderRadius: 3,
  cursor: 'pointer',
};

/**
 * Admin-only. Lists current perm.json entries with Remove buttons,
 * plus a form to add or update an entry. Removes / upserts stage in
 * AppState and bundle into the next Finalize-changes PR.
 */
export function UsersPanel({ onStatus }: UsersPanelProps) {
  const dispatch = useAppDispatch();
  const { owners, pendingUserAdds, pendingUserRemoves } = useAppState();

  const [perms, setPerms] = useState<PermFile | null>(null);
  const [permsError, setPermsError] = useState<string | null>(null);

  const [login, setLogin] = useState('');
  const [role, setRole] = useState<RoleChoice>('player');
  const [nation, setNation] = useState(owners[0] ?? '');

  // Pull perm.json once on mount. Re-fetched only on a manual refresh.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await fetchLiveData<PermFile>('perm.json');
        if (!cancelled) setPerms(p);
      } catch (err) {
        if (!cancelled) setPermsError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep nation valid when owners change.
  useEffect(() => {
    if (owners.length === 0) return;
    if (!owners.includes(nation)) setNation(owners[0]!);
  }, [owners, nation]);

  const lc = (s: string): string => s.trim().toLowerCase();
  const isPendingRemove = (l: string): boolean =>
    pendingUserRemoves.some((r) => lc(r) === lc(l));
  const pendingAddFor = (l: string) =>
    pendingUserAdds.find((u) => lc(u.login) === lc(l));

  const submitForm = (): void => {
    const trimmed = login.trim();
    if (!trimmed) return onStatus('Enter a GitHub login first.');
    if (/[^A-Za-z0-9-]/.test(trimmed)) {
      return onStatus('Login may only contain letters, digits, and dashes.');
    }
    if (role === 'admin') {
      dispatch({ type: 'ADD_PENDING_USER', payload: { login: trimmed, role: 'admin' } });
      onStatus(`Staged @${trimmed} → admin. Finalize changes to commit.`);
    } else {
      if (!nation) return onStatus('Pick a nation.');
      dispatch({
        type: 'ADD_PENDING_USER',
        payload: { login: trimmed, role: 'player', nation: normalizeNation(nation) },
      });
      onStatus(`Staged @${trimmed} → ${nation}. Finalize changes to commit.`);
    }
    // If they were also staged for removal, drop that — adding overrides.
    dispatch({ type: 'UNSTAGE_USER_REMOVE', payload: { login: trimmed } });
    setLogin('');
  };

  const startEdit = (entry: [string, PermEntry]): void => {
    const [l, e] = entry;
    setLogin(l);
    setRole(e.role);
    if (e.role === 'player' && e.nation) setNation(e.nation);
  };

  const stageRemove = (l: string): void => {
    dispatch({ type: 'STAGE_USER_REMOVE', payload: { login: l } });
    // If a pending add existed for this login, drop it — remove takes priority.
    dispatch({ type: 'REMOVE_PENDING_USER', payload: { login: l } });
    onStatus(`Staged removal of @${l}.`);
  };

  const undoRemove = (l: string): void => {
    dispatch({ type: 'UNSTAGE_USER_REMOVE', payload: { login: l } });
  };

  const undoAdd = (l: string): void => {
    dispatch({ type: 'REMOVE_PENDING_USER', payload: { login: l } });
  };

  // Sorted entries for display.
  const entries: Array<[string, PermEntry]> = perms
    ? Object.entries(perms).sort(([a], [b]) => a.localeCompare(b))
    : [];

  const totalPending = pendingUserAdds.length + pendingUserRemoves.length;

  return (
    <Panel title="Players (Admin)">
      <label className={styles.label}>GitHub login</label>
      <input
        type="text"
        className={styles.input}
        placeholder="e.g. alice"
        value={login}
        onChange={(e) => setLogin(e.target.value)}
      />
      <label className={styles.label}>Role</label>
      <select
        className={styles.input}
        value={role}
        onChange={(e) => setRole(e.target.value as RoleChoice)}
      >
        <option value="player">Player</option>
        <option value="admin">Master (admin)</option>
      </select>
      {role === 'player' && (
        <>
          <label className={styles.label}>Nation</label>
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
        </>
      )}
      <Button variant="success" onClick={submitForm} fullWidth style={{ marginTop: 8 }}>
        Add or update
      </Button>

      {/* Existing entries */}
      <div style={{ marginTop: 12 }}>
        <div className={styles.label} style={{ marginBottom: 4 }}>
          Current ({entries.length})
        </div>
        {permsError && (
          <div style={{ fontSize: 11, color: '#c66', margin: '2px 0' }}>
            Couldn’t load perm.json: {permsError}
          </div>
        )}
        {!perms && !permsError && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0' }}>
            Loading…
          </div>
        )}
        {entries.map(([l, e]) => {
          const removing = isPendingRemove(l);
          const updating = pendingAddFor(l);
          return (
            <div
              key={l}
              style={{
                ...rowStyle,
                opacity: removing ? 0.55 : 1,
                textDecoration: removing ? 'line-through' : 'none',
              }}
            >
              <span style={{ flex: 1 }}>
                @{l} —{' '}
                {e.role === 'admin' ? (
                  <span>master</span>
                ) : (
                  <span style={{ textTransform: 'uppercase' }}>{e.nation ?? '?'}</span>
                )}
                {updating && (
                  <span style={{ color: 'var(--warning)', marginLeft: 4 }}>(edited)</span>
                )}
              </span>
              {removing ? (
                <button
                  onClick={() => undoRemove(l)}
                  aria-label={`Undo remove ${l}`}
                  style={xButtonStyle}
                >
                  Undo
                </button>
              ) : (
                <>
                  <button
                    onClick={() => startEdit([l, e])}
                    aria-label={`Edit ${l}`}
                    style={xButtonStyle}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => stageRemove(l)}
                    aria-label={`Remove ${l}`}
                    style={xButtonStyle}
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Pending adds (new logins not yet in perm.json) */}
      {pendingUserAdds.filter((u) => !perms || !(u.login in perms)).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className={styles.label} style={{ marginBottom: 4 }}>
            Pending new
          </div>
          {pendingUserAdds
            .filter((u) => !perms || !(u.login in perms))
            .map((u) => (
              <div key={u.login} style={rowStyle}>
                <span style={{ flex: 1 }}>
                  @{u.login} →{' '}
                  {u.role === 'admin' ? (
                    <span>master</span>
                  ) : (
                    <span style={{ textTransform: 'uppercase' }}>{u.nation}</span>
                  )}
                </span>
                <button
                  onClick={() => undoAdd(u.login)}
                  aria-label={`Undo ${u.login}`}
                  style={xButtonStyle}
                >
                  ×
                </button>
              </div>
            ))}
        </div>
      )}

      <div className={styles.helper}>
        {totalPending > 0
          ? `${totalPending} pending change${totalPending === 1 ? '' : 's'}. Finalize changes to commit.`
          : 'Edits, adds, and removals land in perm.json on your next Finalize changes PR.'}
      </div>
    </Panel>
  );
}
