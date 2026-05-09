import type { ReactNode } from 'react';
import styles from './Panel.module.css';

interface PanelProps {
  title: string;
  children: ReactNode;
}

export function Panel({ title, children }: PanelProps) {
  return (
    <div className={styles.panel}>
      <h3 className={styles.heading}>{title}</h3>
      {children}
    </div>
  );
}

export { styles as panelStyles };
