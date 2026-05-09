import { useMemo } from 'react';
import { useAppState } from '@/state/AppContext';
import { Panel } from '@/components/ui/Panel';

const SWATCH_STYLE: React.CSSProperties = {
  display: 'inline-block',
  width: 10,
  height: 10,
  border: '1px solid #000',
  marginRight: 6,
  verticalAlign: 'middle',
};

export function StatsPanel() {
  const { provinces, palette } = useAppState();

  const top = useMemo(() => {
    if (!provinces) return [];
    const counts: Record<string, number> = {};
    for (const f of provinces.features) {
      const o = f.properties.owner;
      counts[o] = (counts[o] ?? 0) + 1;
    }
    return Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10);
  }, [provinces]);

  return (
    <Panel title="Stats">
      {top.map(([name, count]) => (
        <div
          key={name}
          style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0' }}
        >
          <span style={{ ...SWATCH_STYLE, background: palette[name] ?? '#888' }} />
          <b style={{ color: 'var(--text-primary)' }}>{name}</b>: {count}
        </div>
      ))}
    </Panel>
  );
}
