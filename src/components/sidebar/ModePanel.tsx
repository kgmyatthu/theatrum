import { useAppDispatch, useAppState } from '@/state/AppContext';
import { Panel } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import type { AppMode } from '@/types';
import styles from './ModePanel.module.css';

interface ModePanelProps {
  status: string;
}

const MODE_HINTS: Record<AppMode, string> = {
  view: 'Click for info. Right-click to reassign. Shift+drag to multi-select.',
  'add-force': 'Mode: Add Force — fill form, click on map.',
  ruler: 'Mode: Ruler — click to set start, click again to measure, double-click to finish.',
};

export function ModePanel({ status }: ModePanelProps) {
  const dispatch = useAppDispatch();
  const { mode } = useAppState();

  const setMode = (m: AppMode): void => {
    // Toggle ruler/add-force off if already active
    const next: AppMode = mode === m && m !== 'view' ? 'view' : m;
    dispatch({ type: 'SET_MODE', payload: { mode: next } });
  };

  return (
    <Panel title="Mode">
      <Button active={mode === 'view'} onClick={() => setMode('view')}>
        View / Select
      </Button>
      <Button active={mode === 'add-force'} onClick={() => setMode('add-force')}>
        Add Force
      </Button>
      <Button active={mode === 'ruler'} onClick={() => setMode('ruler')}>
        Ruler
      </Button>
      <div className={styles.actionInfo}>{MODE_HINTS[mode]}</div>
      <div className={styles.status}>{status}</div>
    </Panel>
  );
}
