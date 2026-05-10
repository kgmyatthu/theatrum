import { useState, type FormEvent } from 'react';
import { useAppDispatch, useAppState } from '@/state/AppContext';
import { Panel } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { ColorPicker } from '@/components/ui/ColorPicker';
import { normalizeNation } from '@/utils/nation';
import styles from './NewCountryPanel.module.css';

interface NewCountryPanelProps {
  onStatus: (msg: string) => void;
}

export function NewCountryPanel({ onStatus }: NewCountryPanelProps) {
  const dispatch = useAppDispatch();
  const { owners } = useAppState();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#ff5577');

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return onStatus('Enter a country name first.');
    if (owners.includes(normalizeNation(trimmed))) {
      return onStatus(`'${trimmed}' already exists.`);
    }
    dispatch({ type: 'ADD_COUNTRY', payload: { name: trimmed, color } });
    onStatus(`Added '${trimmed}' (${color}). Use right-click to assign provinces.`);
    setName('');
  };

  return (
    <Panel title="New Country">
      <form onSubmit={submit}>
        <label className={styles.label}>Name</label>
        <input
          className={styles.input}
          type="text"
          placeholder="e.g. Empire of Eldoria"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className={styles.label}>Color</label>
        <ColorPicker value={color} onChange={setColor} />
        <Button type="submit" variant="success" fullWidth style={{ marginTop: 8 }}>
          Add Country
        </Button>
        <div className={styles.helper}>
          New countries appear in the right-click menu. They have no provinces until you assign
          some.
        </div>
      </form>
    </Panel>
  );
}
