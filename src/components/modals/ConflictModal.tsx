import { Button } from '@/components/ui/Button';
import styles from './SubmitMoveModal.module.css';

/**
 * Shown when the periodic state.json refresh detects upstream drift
 * while the user has uncommitted local edits. The only sensible action
 * is to reload — anything they do now would be against a stale baseline
 * and would either get rejected at submit or quietly clobber someone
 * else's move.
 */
export function ConflictModal() {
  return (
    <div className={styles.backdrop}>
      <div className={styles.panel}>
        <h3 className={styles.title}>Map updated</h3>
        <p className={styles.message}>
          Someone else&rsquo;s changes landed while you were editing.
        </p>
        <p className={styles.subnote}>
          Refresh to load the latest state, then redo your move.
        </p>
        <div className={styles.buttons}>
          <Button variant="primary" onClick={() => window.location.reload()}>
            Refresh now
          </Button>
        </div>
      </div>
    </div>
  );
}
