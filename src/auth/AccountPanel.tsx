import { useState } from 'react';
import { Panel } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { useAuth } from './AuthContext';
import { useAppState } from '@/state/AppContext';
import { buildSnapshot } from '@/utils/snapshot';
import type { CountryRename, UserAdd } from './submitMove';
import { SubmitMoveModal } from '@/components/modals/SubmitMoveModal';
import type { AppSnapshot } from '@/types';

interface PendingSubmission {
  snapshot: AppSnapshot;
  renames: CountryRename[];
  userAdds: UserAdd[];
}

interface AccountPanelProps {
  onStatus: (msg: string) => void;
}

export function AccountPanel({ onStatus }: AccountPanelProps) {
  const auth = useAuth();
  const state = useAppState();
  const [pending, setPending] = useState<PendingSubmission | null>(null);

  // Open the modal immediately and hand it the snapshot + renames. The
  // modal owns the diff check and description input, so the click feels
  // instant instead of waiting on a network round-trip.
  const handleSubmitMove = (): void => {
    if (!auth.login) return onStatus('Sign in first.');
    if (!state.provinces) return onStatus('No state to submit.');
    const snapshot = buildSnapshot({
      provinces: state.provinces,
      forces: state.forces,
      nextForceId: state.nextForceId,
      palette: state.palette,
      owners: state.owners,
    });
    const renames = auth.role === 'admin' ? state.pendingRenames : [];
    const userAdds = auth.role === 'admin' ? state.pendingUserAdds : [];
    setPending({ snapshot, renames, userAdds });
  };

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

  const headlineNode =
    auth.role === 'admin' ? (
      <>Master @{auth.login}</>
    ) : auth.role === 'player' ? (
      <>
        @{auth.login} —{' '}
        <span style={{ textTransform: 'uppercase' }}>{auth.nation}</span>
      </>
    ) : (
      <>@{auth.login}</>
    );

  const isAuthed = auth.status === 'authenticated';

  return (
    <>
      <Panel title="Account">
        <div style={{ fontSize: 12, marginBottom: 6 }}>{headlineNode}</div>
        {auth.status === 'unregistered' && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
            Not in perm.json — read-only access. Ask admin to add you.
          </div>
        )}
        <Button onClick={auth.signOut} fullWidth>
          Sign out
        </Button>
        {isAuthed && (
          <Button
            variant="danger"
            onClick={handleSubmitMove}
            fullWidth
            style={{ marginTop: 6 }}
          >
            Finalize changes
          </Button>
        )}
      </Panel>
      {pending && auth.login && (
        <SubmitMoveModal
          login={auth.login}
          snapshot={pending.snapshot}
          renames={pending.renames}
          userAdds={pending.userAdds}
          onClose={() => setPending(null)}
          onAuthExpired={() => {
            auth.signOut();
            auth.signIn();
          }}
        />
      )}
    </>
  );
}
