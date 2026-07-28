import { useState } from 'react';
import { Panel } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { NationsModal } from '@/components/modals/NationsModal';

/** Launcher for the centered nations force-overview modal. */
export function NationsPanel() {
  const [open, setOpen] = useState(false);

  return (
    <Panel title="Nations">
      <Button fullWidth onClick={() => setOpen(true)}>
        Force Overview
      </Button>
      {open && <NationsModal onDismiss={() => setOpen(false)} />}
    </Panel>
  );
}
