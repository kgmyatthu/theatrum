import { Button } from '@/components/ui/Button';
import styles from './SubmitMoveModal.module.css';

/**
 * Shown when the client detects that main's state.json declares a
 * schema version newer than the one this JS bundle was compiled for.
 *
 * The validator rejects submissions from mismatched-schema clients
 * outright, so there's nothing useful the user can do besides hard-
 * refresh and pull the new bundle. We block the UI to make that
 * unambiguous — any local edits would just get rejected at submit.
 */
export function StaleClientModal() {
  return (
    <div className={styles.backdrop}>
      <div className={styles.panel}>
        <h3 className={styles.title}>App update required</h3>
        <p className={styles.message}>
          The map data has moved to a newer format than this browser tab is running.
        </p>
        <p className={styles.subnote}>
          Reload the page to load the latest version. Any uncommitted local edits will be lost.
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
