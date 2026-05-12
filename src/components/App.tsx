import { Sidebar } from './sidebar/Sidebar';
import { MapView } from './map/MapView';
import { ConflictModal } from './modals/ConflictModal';
import { StaleClientModal } from './modals/StaleClientModal';
import { useAppState } from '@/state/AppContext';
import { useDataBootstrap } from '@/hooks/useDataBootstrap';
import { useStateRefresh } from '@/hooks/useStateRefresh';
import styles from './App.module.css';

export function App() {
  useDataBootstrap();
  const { loaded } = useAppState();
  const { conflict, stale } = useStateRefresh();

  if (!loaded) {
    return <div className={styles.loading}>Loading map data…</div>;
  }

  return (
    <div className={styles.app}>
      <Sidebar />
      <MapView />
      {/* Schema-version mismatch trumps a local-edit conflict — refreshing
       *  is the only action that helps either way, and we shouldn't stack
       *  two modals. */}
      {stale ? <StaleClientModal /> : conflict && <ConflictModal />}
    </div>
  );
}
