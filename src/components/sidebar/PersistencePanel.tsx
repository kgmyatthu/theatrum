import { useRef, useState } from 'react';
import { useAppDispatch, useAppState } from '@/state/AppContext';
import { Panel } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { buildSnapshot } from '@/utils/snapshot';
import { exportToSvg, importSnapshotFromSvg } from '@/utils/svgExport';
import { computeBBox, buildCoordSet } from '@/utils/geometry';
import { computeLandmassLabelsForOwner } from '@/utils/connectedComponents';
import { useAuth } from '@/auth/AuthContext';
import { submitMove } from '@/auth/submitMove';
import type { AppSnapshot, ProvinceFeature } from '@/types';

const STORAGE_KEY = 'theatrum';

interface PersistencePanelProps {
  onStatus: (msg: string) => void;
}

export function PersistencePanel({ onStatus }: PersistencePanelProps) {
  const dispatch = useAppDispatch();
  const state = useAppState();
  const auth = useAuth();
  const jsonInputRef = useRef<HTMLInputElement>(null);
  const svgInputRef = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);

  const isAuthed = auth.status === 'authenticated';

  const buildCurrentSnapshot = (): AppSnapshot | null => {
    if (!state.provinces) return null;
    return buildSnapshot({
      provinces: state.provinces,
      forces: state.forces,
      nextForceId: state.nextForceId,
      palette: state.palette,
      owners: state.owners,
      provinceFillOpacity: state.provinceFillOpacity,
    });
  };

  const handleSave = (): void => {
    const snap = buildCurrentSnapshot();
    if (!snap) return onStatus('Nothing to save yet.');
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
      onStatus('Saved to browser storage.');
    } catch (err) {
      onStatus(`Save failed: ${(err as Error).message}`);
    }
  };

  const handleLoad = (): void => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return onStatus('No saved state.');
    try {
      const snap = JSON.parse(raw) as AppSnapshot;
      dispatch({ type: 'APPLY_SNAPSHOT', payload: { snapshot: snap } });
      onStatus('Loaded.');
    } catch (err) {
      onStatus(`Load failed: ${(err as Error).message}`);
    }
  };

  const handleReset = (): void => {
    if (!window.confirm('Reset all changes?')) return;
    localStorage.removeItem(STORAGE_KEY);
    window.location.reload();
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
        dispatch({ type: 'APPLY_SNAPSHOT', payload: { snapshot: snap } });
        onStatus('Imported JSON.');
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
      const text = ev.target?.result as string;
      const snap = importSnapshotFromSvg(text);
      if (!snap) {
        onStatus('No embedded snapshot found in this SVG.');
        return;
      }
      dispatch({ type: 'APPLY_SNAPSHOT', payload: { snapshot: snap } });
      onStatus('Imported snapshot from SVG.');
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleSubmitMove = async (): Promise<void> => {
    if (!auth.token || !auth.login) return onStatus('Sign in first.');
    const snap = buildCurrentSnapshot();
    if (!snap) return onStatus('No state to submit.');
    const description = window.prompt('Describe your move (optional):') ?? '';
    setSubmitting(true);
    try {
      onStatus('Opening pull request…');
      const result = await submitMove({
        token: auth.token,
        login: auth.login,
        snapshot: snap,
        description,
      });
      onStatus(`Submitted PR #${result.prNumber}. Validator will auto-merge if it passes.`);
      window.open(result.prUrl, '_blank', 'noopener');
    } catch (err) {
      onStatus(`Submit failed: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Panel title={isAuthed ? 'Save / Load / Submit' : 'Export / Import'}>
      {isAuthed && (
        <>
          <Button
            variant="primary"
            onClick={handleSubmitMove}
            disabled={submitting}
            fullWidth
          >
            {submitting ? 'Submitting…' : 'Submit move (PR)'}
          </Button>
          <hr style={{ borderColor: 'var(--border)', margin: '8px 0' }} />
          <Button onClick={handleSave}>Save</Button>
          <Button onClick={handleLoad}>Load</Button>
          <Button onClick={handleReset}>Reset</Button>
          <hr style={{ borderColor: 'var(--border)', margin: '8px 0' }} />
        </>
      )}
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
    </Panel>
  );
}
