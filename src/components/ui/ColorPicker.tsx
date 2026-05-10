import { useEffect, useState } from 'react';
import styles from './ColorPicker.module.css';

interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function ColorPicker({ value, onChange }: ColorPickerProps) {
  const [hex, setHex] = useState(value);

  useEffect(() => {
    setHex(value);
  }, [value]);

  const handleColorChange = (next: string): void => {
    setHex(next);
    onChange(next);
  };
  const handleHexChange = (next: string): void => {
    setHex(next);
    if (HEX_RE.test(next)) onChange(next);
  };

  return (
    <div className={styles.row}>
      <input
        type="color"
        className={styles.colorInput}
        value={value}
        onChange={(e) => {
          handleColorChange(e.target.value);
          // Dismiss the native picker dialog (Safari keeps it open otherwise).
          e.target.blur();
        }}
      />
      <input
        type="text"
        className={styles.hexInput}
        value={hex}
        onChange={(e) => handleHexChange(e.target.value)}
      />
    </div>
  );
}
