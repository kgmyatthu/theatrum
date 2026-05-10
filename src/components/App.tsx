import { Sidebar } from './sidebar/Sidebar';
import { MapView } from './map/MapView';
import { ConflictModal } from './modals/ConflictModal';
import { useAppState } from '@/state/AppContext';
import { useDataBootstrap } from '@/hooks/useDataBootstrap';
import { useStateRefresh } from '@/hooks/useStateRefresh';
import styles from './App.module.css';

export function App() {
  useDataBootstrap();
  const { loaded } = useAppState();
  const { conflict } = useStateRefresh();

  if (!loaded) {
    return <div className={styles.loading}>Loading map data…</div>;
  }

  return (
    <div className={styles.app}>
      <Sidebar />
      <MapView />
      {conflict && <ConflictModal />}
    </div>
  );
}
