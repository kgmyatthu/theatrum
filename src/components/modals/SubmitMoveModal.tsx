import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import type { AppSnapshot } from '@/types';
import {
  hasMeaningfulDiff,
  submitMove,
  type CountryRename,
  type UserAdd,
} from '@/auth/submitMove';
import { getPullRequest, listIssueComments, GitHubAuthError } from '@/auth/githubApi';
import styles from './SubmitMoveModal.module.css';

const REPO = (import.meta.env.VITE_GITHUB_REPO as string | undefined) ?? '';

const POLL_INTERVAL_MS = 1500;
const MAX_ATTEMPTS = 80; // ~2 minutes
const MERGE_DISPLAY_MS = 600;

type Phase =
  | { kind: 'checking' }
  | { kind: 'no-changes' }
  | { kind: 'describe' }
  | { kind: 'opening' }
  | { kind: 'polling'; prNumber: number; prUrl: string; attempt: number }
  | { kind: 'merged'; prNumber: number; prUrl: string }
  | { kind: 'rejected'; prNumber: number; prUrl: string; reason: string }
  | { kind: 'timeout'; prNumber: number; prUrl: string }
  | { kind: 'expired' }
  | { kind: 'error'; message: string };

interface SubmitMoveModalProps {
  login: string;
  snapshot: AppSnapshot;
  /** Country renames to mirror into perm.json — admin-only. */
  renames: CountryRename[];
  /** Player additions / nation reassignments to apply to perm.json — admin-only. */
  userAdds: UserAdd[];
  onClose: () => void;
  /** Called when a 401 surfaces — UI prompts re-auth via this. */
  onAuthExpired: () => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Owns the full submit-move lifecycle. The modal opens immediately
 * (no async work in the parent), and the diff check runs as the first
 * in-modal phase so the spinner is visible during the network wait.
 *
 * Phases:
 *   checking → describe (or no-changes terminal)
 *   describe → opening on user submit
 *   opening → polling → merged | rejected | timeout
 *   any → expired | error on faults
 */
export function SubmitMoveModal({
  login,
  snapshot,
  renames,
  userAdds,
  onClose,
  onAuthExpired,
}: SubmitMoveModalProps) {
  const hasPermChanges = renames.length > 0 || userAdds.length > 0;
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [description, setDescription] = useState('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Initial diff check — runs once per modal mount.
  useEffect(() => {
    (async () => {
      try {
        const changed = await hasMeaningfulDiff(snapshot);
        if (!mountedRef.current) return;
        // Pending perm.json edits (renames or user adds) count as a
        // submittable change even if state.json matches main.
        setPhase(changed || hasPermChanges ? { kind: 'describe' } : { kind: 'no-changes' });
      } catch (err) {
        if (!mountedRef.current) return;
        if (err instanceof GitHubAuthError) {
          setPhase({ kind: 'expired' });
        } else {
          setPhase({ kind: 'error', message: (err as Error).message });
        }
      }
    })();
  }, [snapshot, hasPermChanges]);

  // Open the PR, then poll for the validator's verdict. Triggered by the
  // Submit button in the 'describe' phase, not from a useEffect — the
  // user controls when the network work starts.
  const startSubmit = async (): Promise<void> => {
    setPhase({ kind: 'opening' });

    let prNumber: number;
    let prUrl: string;
    try {
      const r = await submitMove({ login, snapshot, description, renames, userAdds });
      if (!mountedRef.current) return;
      prNumber = r.prNumber;
      prUrl = r.prUrl;
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof GitHubAuthError) {
        setPhase({ kind: 'expired' });
      } else {
        setPhase({ kind: 'error', message: (err as Error).message });
      }
      return;
    }

    setPhase({ kind: 'polling', prNumber, prUrl, attempt: 1 });
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await sleep(POLL_INTERVAL_MS);
      if (!mountedRef.current) return;
      try {
        const pr = await getPullRequest(REPO, prNumber);
        if (pr.merged) {
          if (mountedRef.current) setPhase({ kind: 'merged', prNumber, prUrl });
          return;
        }
        if (pr.state === 'closed') {
          let reason = 'The validator workflow closed the PR without merging.';
          try {
            const comments = await listIssueComments(REPO, prNumber);
            const bot = comments.filter((c) => c.user.login === 'github-actions[bot]').pop();
            if (bot?.body) {
              const m = bot.body.match(/Move rejected by validator:\s*(.+)/);
              reason = (m ? m[1]! : bot.body).trim();
            }
          } catch {
            // keep generic reason
          }
          if (mountedRef.current) setPhase({ kind: 'rejected', prNumber, prUrl, reason });
          return;
        }
        if (mountedRef.current) {
          setPhase({ kind: 'polling', prNumber, prUrl, attempt: i + 1 });
        }
      } catch (err) {
        if (err instanceof GitHubAuthError) {
          if (mountedRef.current) setPhase({ kind: 'expired' });
          return;
        }
        // Transient API errors during polling — keep going.
        // eslint-disable-next-line no-console
        console.warn('Poll error:', err);
      }
    }
    if (mountedRef.current) setPhase({ kind: 'timeout', prNumber, prUrl });
  };

  // Auto-reload after the merge confirmation so the bootstrap picks up
  // the new state.json. Short pause so the user sees the success message.
  useEffect(() => {
    if (phase.kind !== 'merged') return;
    const t = window.setTimeout(() => window.location.reload(), MERGE_DISPLAY_MS);
    return () => window.clearTimeout(t);
  }, [phase.kind]);

  return (
    <div className={styles.backdrop}>
      <div className={styles.panel}>
        <h3 className={styles.title}>Submit Move</h3>
        {renderPhase(phase, description, setDescription, startSubmit, onClose, onAuthExpired)}
      </div>
    </div>
  );
}

function renderPhase(
  phase: Phase,
  description: string,
  setDescription: (v: string) => void,
  onStartSubmit: () => void,
  onClose: () => void,
  onAuthExpired: () => void,
) {
  switch (phase.kind) {
    case 'checking':
      return (
        <>
          <div className={styles.spinner} />
          <p className={styles.message}>Checking for changes…</p>
        </>
      );
    case 'no-changes':
      return (
        <>
          <p className={styles.message}>No changes to submit.</p>
          <p className={styles.subnote}>Make some edits, then try again.</p>
          <div className={styles.buttons}>
            <Button onClick={onClose}>Close</Button>
          </div>
        </>
      );
    case 'describe':
      return (
        <>
          <p className={styles.message} style={{ textAlign: 'left' }}>
            Describe your move (optional):
          </p>
          <textarea
            className={styles.textarea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. moved 5th Army to Vienna"
            autoFocus
          />
          <div className={styles.buttons}>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={onStartSubmit}>
              Submit
            </Button>
          </div>
        </>
      );
    case 'opening':
      return (
        <>
          <div className={styles.spinner} />
          <p className={styles.message}>Opening pull request…</p>
        </>
      );
    case 'polling':
      return (
        <>
          <div className={styles.spinner} />
          <p className={styles.message}>
            Validating PR #{phase.prNumber}… ({phase.attempt}/{MAX_ATTEMPTS})
          </p>
          <p className={styles.subnote}>
            <a href={phase.prUrl} target="_blank" rel="noopener noreferrer">
              View on GitHub
            </a>
          </p>
        </>
      );
    case 'merged':
      return (
        <>
          <p className={styles.success}>Move accepted (PR #{phase.prNumber})</p>
          <p className={styles.subnote}>Reloading with the latest state…</p>
        </>
      );
    case 'rejected':
      return (
        <>
          <p className={styles.error}>Move rejected</p>
          <p className={styles.message}>{phase.reason}</p>
          <p className={styles.subnote}>
            Refresh the page to load the latest state, then try again.
          </p>
          <div className={styles.buttons}>
            <Button onClick={onClose}>Close</Button>
            <Button variant="primary" onClick={() => window.location.reload()}>
              Refresh now
            </Button>
          </div>
          <p className={styles.subnote} style={{ marginTop: 8 }}>
            <a href={phase.prUrl} target="_blank" rel="noopener noreferrer">
              View PR #{phase.prNumber}
            </a>
          </p>
        </>
      );
    case 'timeout':
      return (
        <>
          <p className={styles.warning}>Validator is taking longer than usual</p>
          <p className={styles.message}>Check PR #{phase.prNumber} on GitHub for status.</p>
          <div className={styles.buttons}>
            <Button onClick={onClose}>Close</Button>
            <Button variant="primary" onClick={() => window.open(phase.prUrl, '_blank', 'noopener')}>
              View PR
            </Button>
          </div>
        </>
      );
    case 'expired':
      return (
        <>
          <p className={styles.warning}>Sign-in expired</p>
          <p className={styles.message}>
            GitHub tokens last 8 hours. Sign in again to retry your move.
          </p>
          <p className={styles.subnote}>
            Note: re-signing redirects to GitHub, so any unsubmitted local edits will be lost.
          </p>
          <div className={styles.buttons}>
            <Button onClick={onClose}>Close</Button>
            <Button variant="primary" onClick={onAuthExpired}>
              Sign in again
            </Button>
          </div>
        </>
      );
    case 'error':
      return (
        <>
          <p className={styles.error}>Submit failed</p>
          <p className={styles.message}>{phase.message}</p>
          <div className={styles.buttons}>
            <Button onClick={onClose}>Close</Button>
          </div>
        </>
      );
  }
}
