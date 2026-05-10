import { useState } from 'react';
import { ModePanel } from './ModePanel';
import { AddForcePanel } from './AddForcePanel';
import { NewCountryPanel } from './NewCountryPanel';
import { EditCountryPanel } from './EditCountryPanel';
import { DisplayPanel } from './DisplayPanel';
import { LayersPanel } from './LayersPanel';
import { PersistencePanel } from './PersistencePanel';
import { StatsPanel } from './StatsPanel';
import { AccountPanel } from '@/auth/AccountPanel';
import { useAuth } from '@/auth/AuthContext';
import styles from './Sidebar.module.css';

export function Sidebar() {
  const [status, setStatus] = useState('Ready.');
  const auth = useAuth();

  const isAuthed = auth.status === 'authenticated';
  const isAdmin = auth.role === 'admin';
  // Player + admin get gameplay panels (Mode / AddForce / Stats). Country
  // admin (rename / recolor / new) is admin-only. Layers is purely a
  // client-side render toggle, so everyone gets it.
  const showGameplayPanels = isAuthed;

  return (
    <div className={styles.sidebar}>
      <h2 className={styles.title}>Theatrum</h2>
      <AccountPanel />

      {showGameplayPanels && <ModePanel status={status} />}
      {showGameplayPanels && <AddForcePanel onStatus={setStatus} />}
      {isAdmin && <NewCountryPanel onStatus={setStatus} />}
      {isAdmin && <EditCountryPanel onStatus={setStatus} />}
      {showGameplayPanels && <DisplayPanel />}
      <LayersPanel />
      <PersistencePanel onStatus={setStatus} />
      {showGameplayPanels && <StatsPanel />}
    </div>
  );
}
