import { useEffect, useState } from 'react';
import { useAppDispatch, useAppState } from '@/state/AppContext';
import { Panel } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { ColorPicker } from '@/components/ui/ColorPicker';
import { normalizeNation } from '@/utils/nation';
import styles from './NewCountryPanel.module.css';

interface EditCountryPanelProps {
  onStatus: (msg: string) => void;
}

export function EditCountryPanel({ onStatus }: EditCountryPanelProps) {
  const dispatch = useAppDispatch();
  const { owners, palette } = useAppState();

  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [color, setColor] = useState('#888888');

  // Initialize selection on first render
  useEffect(() => {
    if (!selected && owners.length > 0) {
      setSelected(owners[0]!);
    }
    // If the selected owner was renamed away, fall back to the first owner
    if (selected && !owners.includes(selected) && owners.length > 0) {
      setSelected(owners[0]!);
    }
  }, [owners, selected]);

  // Sync name/color when selected country changes externally
  useEffect(() => {
    if (selected) {
      setName(selected);
      setColor(palette[selected] ?? '#888888');
    }
  }, [selected, palette]);

  const handleRename = (): void => {
    const newName = name.trim();
    if (!selected) return onStatus('Pick a country first.');
    if (!newName) return onStatus('Enter a new name.');
    const norm = normalizeNation(newName);
    if (norm === selected) return onStatus('Name unchanged.');
    if (owners.includes(norm)) return onStatus(`'${newName}' already exists.`);
    dispatch({ type: 'RENAME_COUNTRY', payload: { oldName: selected, newName } });
    onStatus(`Renamed '${selected}' → '${newName}'.`);
    setSelected(norm);
  };

  const handleColor = (): void => {
    if (!selected) return onStatus('Pick a country first.');
    dispatch({ type: 'CHANGE_COUNTRY_COLOR', payload: { name: selected, color } });
    onStatus(`Updated '${selected}' color to ${color}.`);
  };

  return (
    <Panel title="Edit Country">
      <label className={styles.label}>Country</label>
      <select
        className={styles.input}
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        style={{ textTransform: 'uppercase' }}
      >
        {owners.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>

      <label className={styles.label}>New Name</label>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="text"
          className={styles.input}
          style={{ flex: 1 }}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button variant="primary" onClick={handleRename}>
          Rename
        </Button>
      </div>

      <label className={styles.label}>New Color</label>
      <ColorPicker value={color} onChange={setColor} />
      <Button
        variant="primary"
        fullWidth
        onClick={handleColor}
        style={{ marginTop: 8 }}
      >
        Apply Color
      </Button>
      <div className={styles.helper}>
        Renaming updates the country everywhere — provinces, forces, dropdowns.
      </div>
    </Panel>
  );
}
