import { useEffect, useState } from 'react';
import { useAppDispatch, useAppState } from '@/state/AppContext';
import { Panel } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { normalizeNation } from '@/utils/nation';
import styles from './NewCountryPanel.module.css';

interface UsersPanelProps {
  onStatus: (msg: string) => void;
}

/**
 * Admin-only. Stages player additions / nation reassignments. Each entry
 * is bundled into the next "Finalize changes" PR's perm.json commit.
 */
export function UsersPanel({ onStatus }: UsersPanelProps) {
  const dispatch = useAppDispatch();
  const { owners, pendingUserAdds } = useAppState();

  const [login, setLogin] = useState('');
  const [nation, setNation] = useState(owners[0] ?? '');

  // Keep nation valid when owners change
  useEffect(() => {
    if (owners.length === 0) return;
    if (!owners.includes(nation)) setNation(owners[0]!);
  }, [owners, nation]);

  const handleAdd = (): void => {
    const trimmed = login.trim();
    if (!trimmed) return onStatus('Enter a GitHub login first.');
    if (!nation) return onStatus('Pick a nation.');
    if (/[^A-Za-z0-9-]/.test(trimmed)) {
      return onStatus('Login may only contain letters, digits, and dashes.');
    }
    dispatch({
      type: 'ADD_PENDING_USER',
      payload: { login: trimmed, nation: normalizeNation(nation) },
    });
    onStatus(`Staged @${trimmed} → ${nation}. Finalize changes to commit.`);
    setLogin('');
  };

  const handleRemove = (loginToRemove: string): void => {
    dispatch({ type: 'REMOVE_PENDING_USER', payload: { login: loginToRemove } });
  };

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
      <Button variant="success" onClick={handleAdd} fullWidth style={{ marginTop: 8 }}>
        Add Player
      </Button>
      {pendingUserAdds.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className={styles.label} style={{ marginBottom: 4 }}>
            Pending ({pendingUserAdds.length})
          </div>
          {pendingUserAdds.map((u) => (
            <div
              key={u.login}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                margin: '2px 0',
                color: 'var(--text-primary)',
              }}
            >
              <span style={{ flex: 1 }}>
                @{u.login} →{' '}
                <span style={{ textTransform: 'uppercase' }}>{u.nation}</span>
              </span>
              <button
                onClick={() => handleRemove(u.login)}
                aria-label={`Remove ${u.login}`}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  color: 'var(--text-muted)',
                  fontSize: 11,
                  lineHeight: 1,
                  padding: '1px 6px',
                  borderRadius: 3,
                  cursor: 'pointer',
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className={styles.helper}>
        Staged adds land in perm.json on your next Finalize changes PR.
      </div>
    </Panel>
  );
}
