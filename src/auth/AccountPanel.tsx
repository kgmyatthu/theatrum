import { Panel } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { useAuth } from './AuthContext';

export function AccountPanel() {
  const auth = useAuth();

  if (auth.status === 'loading') {
    return (
      <Panel title="Account">
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Checking sign-in…</div>
      </Panel>
    );
  }

  if (auth.status === 'anonymous') {
    return (
      <Panel title="Account">
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
          Not signed in.
        </div>
        <Button variant="primary" onClick={auth.signIn} fullWidth>
          Sign in with GitHub
        </Button>
      </Panel>
    );
  }

  const headline =
    auth.role === 'admin'
      ? `Master @${auth.login}`
      : auth.role === 'player'
        ? `@${auth.login} — ${auth.nation}`
        : `@${auth.login}`;

  return (
    <Panel title="Account">
      <div style={{ fontSize: 12, marginBottom: 6 }}>{headline}</div>
      {auth.status === 'unregistered' && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
          Not in perm.json — read-only access. Ask admin to add you.
        </div>
      )}
      <Button onClick={auth.signOut} fullWidth>
        Sign out
      </Button>
    </Panel>
  );
}
