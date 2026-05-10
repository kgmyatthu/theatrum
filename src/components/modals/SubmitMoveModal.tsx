import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import type { AppSnapshot } from '@/types';
import { submitMove } from '@/auth/submitMove';
import { getPullRequest, listIssueComments, GitHubAuthError } from '@/auth/githubApi';
import styles from './SubmitMoveModal.module.css';

const REPO = (import.meta.env.VITE_GITHUB_REPO as string | undefined) ?? '';

const POLL_INTERVAL_MS = 3000;
const MAX_ATTEMPTS = 60; // ~3 minutes

type Phase =
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
  description: string;
  onClose: () => void;
  /** Called when a 401 surfaces — UI prompts re-auth via this. */
  onAuthExpired: () => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Owns the full submit-move lifecycle: opens the PR via GitHub API, then
 * polls every POLL_INTERVAL_MS for the validator workflow's verdict
 * (merged → success, closed without merge → rejected, timeout otherwise).
 * On success, reloads the page so the bootstrap re-fetches the live
 * state.json from main. On rejection, surfaces the validator's last
 * comment as the reason and prompts a refresh-and-retry.
 */
export function SubmitMoveModal({
  login,
  snapshot,
  description,
  onClose,
  onAuthExpired,
}: SubmitMoveModalProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'opening' });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 1. Open the PR
      let prNumber: number;
      let prUrl: string;
      try {
        const r = await submitMove({ login, snapshot, description });
        if (cancelled) return;
        prNumber = r.prNumber;
        prUrl = r.prUrl;
      } catch (err) {
        if (cancelled) return;
        if (err instanceof GitHubAuthError) {
          setPhase({ kind: 'expired' });
        } else {
          setPhase({ kind: 'error', message: (err as Error).message });
        }
        return;
      }

      // 2. Poll until merged/closed/timeout
      setPhase({ kind: 'polling', prNumber, prUrl, attempt: 1 });
      for (let i = 1; i <= MAX_ATTEMPTS; i++) {
        await sleep(POLL_INTERVAL_MS);
        if (cancelled) return;
        try {
          const pr = await getPullRequest(REPO, prNumber);
          if (pr.merged) {
            if (!cancelled) setPhase({ kind: 'merged', prNumber, prUrl });
            return;
          }
          if (pr.state === 'closed') {
            // Closed without merge → rejected. Pull the validator's last
            // comment as the reason; the workflow leaves a single line
            // beginning with "Move rejected by validator: <reason>".
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
            if (!cancelled) setPhase({ kind: 'rejected', prNumber, prUrl, reason });
            return;
          }
          if (!cancelled) {
            setPhase({ kind: 'polling', prNumber, prUrl, attempt: i + 1 });
          }
        } catch (err) {
          if (err instanceof GitHubAuthError) {
            if (!cancelled) setPhase({ kind: 'expired' });
            return;
          }
          // Transient API errors during polling — keep going.
          // eslint-disable-next-line no-console
          console.warn('Poll error:', err);
        }
      }
      if (!cancelled) setPhase({ kind: 'timeout', prNumber, prUrl });
    })();

    return () => {
      cancelled = true;
    };
  }, [login, snapshot, description]);

  // Auto-reload after the merge confirmation so the bootstrap picks up
  // the new state.json. Short pause so the user sees the success message.
  useEffect(() => {
    if (phase.kind !== 'merged') return;
    const t = window.setTimeout(() => window.location.reload(), 1500);
    return () => window.clearTimeout(t);
  }, [phase.kind]);

  return (
    <div className={styles.backdrop}>
      <div className={styles.panel}>
        <h3 className={styles.title}>Submit Move</h3>
        {renderPhase(phase, onClose, onAuthExpired)}
      </div>
    </div>
  );
}

function renderPhase(phase: Phase, onClose: () => void, onAuthExpired: () => void) {
  switch (phase.kind) {
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
