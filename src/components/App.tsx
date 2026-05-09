import { Sidebar } from './sidebar/Sidebar';
import { MapView } from './map/MapView';
import { useAppState } from '@/state/AppContext';
import { useDataBootstrap } from '@/hooks/useDataBootstrap';
import styles from './App.module.css';

export function App() {
  useDataBootstrap();
  const { loaded } = useAppState();

  if (!loaded) {
    return <div className={styles.loading}>Loading map data…</div>;
  }

  return (
    <div className={styles.app}>
      <Sidebar />
      <MapView />
    </div>
  );
}
