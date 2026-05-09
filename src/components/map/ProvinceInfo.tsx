import { useAppState } from '@/state/AppContext';
import type { ProvinceFeature } from '@/types';
import styles from './ProvinceInfo.module.css';

interface ProvinceInfoProps {
  feature: ProvinceFeature;
}

export function ProvinceInfo({ feature }: ProvinceInfoProps) {
  const { palette } = useAppState();
  const { province_name, modern_country, owner } = feature.properties;
  const color = palette[owner] ?? '#888';

  return (
    <div className={styles.info}>
      <div className={styles.row}>
        <span className={styles.key}>Province</span>
        <span className={styles.value}>{province_name}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.key}>Modern</span>
        <span className={styles.value}>{modern_country}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.key}>Owner</span>
        <span className={styles.value}>
          <span className={styles.swatch} style={{ background: color }} />
          {owner}
        </span>
      </div>
    </div>
  );
}
