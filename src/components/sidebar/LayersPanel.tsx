import { useAppDispatch, useAppState } from '@/state/AppContext';
import { Panel } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import type { LayerVisibility } from '@/state/state';

const LAYERS: Array<{ key: keyof LayerVisibility; label: string }> = [
  { key: 'provinces', label: 'Provinces' },
  { key: 'countryLabels', label: 'Country Labels' },
  { key: 'cities', label: 'Cities' },
  { key: 'forces', label: 'Forces' },
];

export function LayersPanel() {
  const dispatch = useAppDispatch();
  const { layerVisibility } = useAppState();

  return (
    <Panel title="Layers">
      {LAYERS.map((layer) => (
        <Button
          key={layer.key}
          active={layerVisibility[layer.key]}
          onClick={() => dispatch({ type: 'TOGGLE_LAYER', payload: { layer: layer.key } })}
        >
          {layer.label}
        </Button>
      ))}
    </Panel>
  );
}
