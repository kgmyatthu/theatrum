import { useAppDispatch, useAppState } from '@/state/AppContext';
import { Panel } from '@/components/ui/Panel';

export function DisplayPanel() {
  const dispatch = useAppDispatch();
  const { provinceFillOpacity, iconScale } = useAppState();
  const pct = Math.round(provinceFillOpacity * 100);
  const scalePct = Math.round(iconScale * 100);

  return (
    <Panel title="Display">
      <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block' }}>
        Province opacity: <span>{pct}%</span>
      </label>
      <input
        type="range"
        min={0}
        max={100}
        value={pct}
        onChange={(e) =>
          dispatch({ type: 'SET_OPACITY', payload: { opacity: Number(e.target.value) / 100 } })
        }
        style={{ width: '100%' }}
      />
      <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginTop: 8 }}>
        Icon scale: <span>{scalePct}%</span>
      </label>
      <input
        type="range"
        min={50}
        max={150}
        value={scalePct}
        onChange={(e) =>
          dispatch({ type: 'SET_ICON_SCALE', payload: { scale: Number(e.target.value) / 100 } })
        }
        style={{ width: '100%' }}
      />
    </Panel>
  );
}
