import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppDispatch, useAppState } from '@/state/AppContext';
import { Panel } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { buildSnapshot } from '@/utils/snapshot';
import { exportToSvg, importSnapshotFromSvg } from '@/utils/svgExport';
import { computeBBox, buildCoordSet } from '@/utils/geometry';
import { computeLandmassLabelsForOwner } from '@/utils/connectedComponents';
import { prepareImportSnapshot } from '@/utils/population';
import styles from '@/components/modals/MobilizationConfirm.module.css';
import type { AppSnapshot, ProvinceFeature } from '@/types';

interface PersistencePanelProps {
  onStatus: (msg: string) => void;
}

export function PersistencePanel({ onStatus }: PersistencePanelProps) {
  const dispatch = useAppDispatch();
  const state = useAppState();
  const jsonInputRef = useRef<HTMLInputElement>(null);
  const svgInputRef = useRef<HTMLInputElement>(null);
  const [pendingImport, setPendingImport] = useState<{
    snapshot: AppSnapshot;
    source: 'JSON' | 'SVG';
  } | null>(null);
  const importErrors = useMemo(() => {
    if (!pendingImport) return null;
    let preserve: string | null = null;
    let rebuild: string | null = null;
    try {
      prepareImportSnapshot(pendingImport.snapshot, state.provinces, false);
    } catch (error) {
      preserve = (error as Error).message;
    }
    try {
      prepareImportSnapshot(pendingImport.snapshot, state.provinces, true);
    } catch (error) {
      rebuild = (error as Error).message;
    }
    return { preserve, rebuild };
  }, [pendingImport, state.provinces, state.provincesVersion]);

  useEffect(() => {
    if (!pendingImport) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setPendingImport(null);
        onStatus('Import cancelled.');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pendingImport, onStatus]);

  const confirmImport = (rebuildPopulation: boolean): void => {
    if (!pendingImport) return;
    try {
      // Revalidate against the current loaded data immediately before dispatch.
      prepareImportSnapshot(pendingImport.snapshot, state.provinces, rebuildPopulation);
      dispatch({
        type: 'IMPORT_SNAPSHOT',
        payload: { snapshot: pendingImport.snapshot, rebuildPopulation },
      });
      onStatus(
        `Imported ${pendingImport.source}; recruitment population ${
          rebuildPopulation ? 'rebuilt from imported territory' : 'preserved'
        }.`,
      );
      setPendingImport(null);
    } catch (error) {
      onStatus(`Import failed: ${(error as Error).message}`);
    }
  };

  const buildCurrentSnapshot = (): AppSnapshot | null => {
    if (!state.provinces) return null;
    return buildSnapshot({
      provinces: state.provinces,
      forces: state.forces,
      palette: state.palette,
      owners: state.owners,
      currentDate: state.currentDate,
      lastTurnDays: state.lastTurnDays,
      turnNumber: state.turnNumber,
      populationByNation: state.populationByNation,
    });
  };

  const downloadBlob = (data: string, type: string, ext: string): void => {
    const blob = new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `theatrum_${new Date().toISOString().slice(0, 10)}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportJson = (): void => {
    const snap = buildCurrentSnapshot();
    if (!snap) return onStatus('Nothing to export yet.');
    downloadBlob(JSON.stringify(snap, null, 2), 'application/json', 'json');
    onStatus('Exported JSON.');
  };

  const handleExportSvg = (): void => {
    const snap = buildCurrentSnapshot();
    if (!snap || !state.provinces) return onStatus('Nothing to export yet.');

    const bboxes = new Map<number, ReturnType<typeof computeBBox>>();
    const coordSets = new Map<number, Set<string>>();
    for (const f of state.provinces.features) {
      const fid = f.properties._fid;
      bboxes.set(fid, computeBBox(f.geometry));
      coordSets.set(fid, buildCoordSet(f.geometry));
    }
    const featuresByOwner = new Map<string, ProvinceFeature[]>();
    for (const f of state.provinces.features) {
      const o = f.properties.owner;
      if (!o || o === 'Unclaimed') continue;
      let arr = featuresByOwner.get(o);
      if (!arr) {
        arr = [];
        featuresByOwner.set(o, arr);
      }
      arr.push(f);
    }
    const SVG_LABEL_SHRINK = 0.5;
    const countryLabels: Array<{ name: string; lon: number; lat: number; fontSize: number }> = [];
    for (const [owner, feats] of featuresByOwner) {
      const labels = computeLandmassLabelsForOwner(feats, coordSets, bboxes);
      for (const lbl of labels) {
        const baseFont = Math.min(20, Math.max(10, Math.sqrt(lbl.area) * 1.5));
        countryLabels.push({
          name: owner,
          lon: lbl.lon,
          lat: lbl.lat,
          fontSize: baseFont * SVG_LABEL_SHRINK,
        });
      }
    }

    const svg = exportToSvg({
      provinces: state.provinces,
      palette: state.palette,
      forces: state.forces,
      snapshot: snap,
      countryLabels,
      fillOpacity: state.provinceFillOpacity,
    });
    downloadBlob(svg, 'image/svg+xml', 'svg');
    onStatus('Exported SVG with embedded snapshot.');
  };

  const handleImportJsonClick = (): void => jsonInputRef.current?.click();
  const handleImportSvgClick = (): void => svgInputRef.current?.click();

  const handleJsonFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = ev.target?.result as string;
        const snap = JSON.parse(text) as AppSnapshot;
        setPendingImport({ snapshot: snap, source: 'JSON' });
      } catch (err) {
        onStatus(`Import failed: ${(err as Error).message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleSvgFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = ev.target?.result as string;
        const snap = importSnapshotFromSvg(text);
        if (!snap) {
          onStatus('No embedded snapshot found in this SVG.');
          return;
        }
        setPendingImport({ snapshot: snap, source: 'SVG' });
      } catch (err) {
        onStatus(`Import failed: ${(err as Error).message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <Panel title="Export / Import">
      <Button onClick={handleExportJson}>Export JSON</Button>
      <Button onClick={handleImportJsonClick}>Import JSON</Button>
      <Button onClick={handleExportSvg}>Export SVG</Button>
      <Button onClick={handleImportSvgClick}>Import SVG</Button>
      <input
        ref={jsonInputRef}
        type="file"
        accept=".json,application/json"
        onChange={handleJsonFile}
        style={{ display: 'none' }}
      />
      <input
        ref={svgInputRef}
        type="file"
        accept=".svg,image/svg+xml"
        onChange={handleSvgFile}
        style={{ display: 'none' }}
      />
      {pendingImport && importErrors && (
        <div
          className={styles.backdrop}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setPendingImport(null);
              onStatus('Import cancelled.');
            }
          }}
        >
          <div
            className={styles.panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-population-title"
          >
            <h3 id="import-population-title" className={styles.title}>
              Import {pendingImport.source} snapshot
            </h3>
            <p>
              Preserve the imported turn-start recruitment population, or rebuild recruitment
              population from imported territory without advancing date. The snapshot's date and
              force turn anchors are kept either way.
            </p>
            <p>
              A difference from current territory can be a valid mid-turn anchor. Rebuild only if
              you want imported territory to define recruitment instead.
            </p>
            {importErrors.preserve && (
              <p role="alert">
                Cannot preserve: {importErrors.preserve} Explicitly choose Rebuild to import with a
                new population anchor.
              </p>
            )}
            {importErrors.rebuild && (
              <p role="alert">Cannot rebuild: {importErrors.rebuild}</p>
            )}
            <div className={styles.buttons}>
              <Button
                onClick={() => {
                  setPendingImport(null);
                  onStatus('Import cancelled.');
                }}
              >
                Cancel
              </Button>
              <Button disabled={importErrors.preserve !== null} onClick={() => confirmImport(false)}>
                Preserve
              </Button>
              <Button disabled={importErrors.rebuild !== null} onClick={() => confirmImport(true)}>
                Rebuild
              </Button>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}
