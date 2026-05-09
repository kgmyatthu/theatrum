import { useState } from 'react';
import { ModePanel } from './ModePanel';
import { AddForcePanel } from './AddForcePanel';
import { NewCountryPanel } from './NewCountryPanel';
import { EditCountryPanel } from './EditCountryPanel';
import { DisplayPanel } from './DisplayPanel';
import { LayersPanel } from './LayersPanel';
import { PersistencePanel } from './PersistencePanel';
import { StatsPanel } from './StatsPanel';
import styles from './Sidebar.module.css';

export function Sidebar() {
  const [status, setStatus] = useState('Ready.');

  return (
    <div className={styles.sidebar}>
      <h2 className={styles.title}>Theatrum</h2>
      <ModePanel status={status} />
      <AddForcePanel onStatus={setStatus} />
      <NewCountryPanel onStatus={setStatus} />
      <EditCountryPanel onStatus={setStatus} />
      <DisplayPanel />
      <LayersPanel />
      <PersistencePanel onStatus={setStatus} />
      <StatsPanel />
    </div>
  );
}
