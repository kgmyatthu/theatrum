import { useEffect, useRef, useState } from 'react';
import { useAppState } from '@/state/AppContext';
import styles from './ContextMenu.module.css';

export interface ContextMenuPosition {
  x: number;
  y: number;
}

interface ContextMenuProps {
  position: ContextMenuPosition;
  selectedCount: number;
  onPick: (owner: string) => void;
  onDismiss: () => void;
}

const MENU_WIDTH = 240;
const MENU_HEIGHT = 400;

export function ContextMenu({ position, selectedCount, onPick, onDismiss }: ContextMenuProps) {
  const { owners, palette } = useAppState();
  const [filter, setFilter] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Focus filter on mount
  useEffect(() => {
    filterRef.current?.focus();
  }, []);

  // Dismiss on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  // Dismiss on outside click
  useEffect(() => {
    const onMouseDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [onDismiss]);

  const left = Math.min(position.x, window.innerWidth - MENU_WIDTH - 10);
  const top = Math.min(position.y, window.innerHeight - MENU_HEIGHT - 10);
  const lower = filter.toLowerCase();
  const visible = lower ? owners.filter((o) => o.toLowerCase().includes(lower)) : owners;
  const headerText =
    selectedCount > 1 ? `Reassign ${selectedCount} provinces` : 'Reassign province';

  return (
    <div ref={menuRef} className={styles.menu} style={{ left, top }}>
      <div className={styles.header}>{headerText}</div>
      <input
        ref={filterRef}
        className={styles.filter}
        type="text"
        placeholder="Filter countries…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className={styles.list}>
        {visible.map((owner) => (
          <div key={owner} className={styles.row} onClick={() => onPick(owner)}>
            <div
              className={styles.swatch}
              style={{ background: palette[owner] ?? '#888' }}
            />
            {owner}
          </div>
        ))}
      </div>
    </div>
  );
}
