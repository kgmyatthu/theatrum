import { useAppState } from '@/state/AppContext';
import type { ProvinceFeature } from '@/types';
import { NationPower } from './NationPower';
import styles from './ProvinceInfo.module.css';

interface ProvinceInfoProps {
  feature: ProvinceFeature;
}

export function ProvinceInfo({ feature }: ProvinceInfoProps) {
  const { palette } = useAppState();
  const { province_name, modern_country, owner, population1800 } = feature.properties;
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
      <div className={styles.row}>
        {/* "Pop. 1800" not "Population" — it is a raster-derived estimate for a
            single year, and the dated label keeps it from reading as a live
            figure the game maintains. */}
        <span className={styles.key}>Pop. 1800</span>
        {/* Em dash when the bake has no figure for this adm1_code (or the file
            failed to load): a blank is honest about "we don't know", whereas 0
            would assert an empty province and NaN would just look broken. */}
        <span className={styles.value}>
          {typeof population1800 === 'number' ? population1800.toLocaleString('en-US') : '—'}
        </span>
      </div>
      {/* Nested, not a sibling in MapView. A sibling would need its own
          absolute anchor whose `top` is this card's rendered height — a
          number that changes with every province name's wrapping and that
          CSS cannot ask for. As a child, "directly below the rows" is just
          document order, and the anchor, the surface, the border and
          pointer-events:none are all inherited rather than re-derived. */}
      <NationPower nation={owner} />
    </div>
  );
}
