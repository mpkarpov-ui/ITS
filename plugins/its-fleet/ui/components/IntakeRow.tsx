// One row per running intake; Restart/Stop fire shell commands.

import { commands, useCommand } from '@its/sdk-react';
import './IntakeRow.css';

export type Intake = {
  instance_id: string;
  plugin: string;
  instance_key: string;
  pid: number;
};

export function IntakeRow({
  intake,
  station,
}: {
  intake: Intake;
  station: string;
}) {
  const restart = useCommand(commands.itsShell.restart(station));
  const disconnect = useCommand(commands.itsShell.disconnect(station));

  return (
    <div class="intake-row">
      <div class="intake-id">{intake.instance_id}</div>
      <div class="intake-meta">
        <span class="intake-plugin">{intake.plugin}</span>
        <span class="intake-key">key={intake.instance_key}</span>
        <span class="intake-pid">pid={intake.pid}</span>
      </div>
      <div class="intake-actions">
        <button
          class="intake-btn"
          onClick={async () => {
            const r = await restart({ instance_id: intake.instance_id });
            if (!r.ok) alert('restart failed');
          }}
        >
          Restart
        </button>
        <button
          class="intake-btn intake-btn-stop"
          onClick={async () => {
            const r = await disconnect({ instance_id: intake.instance_id });
            if (!r.ok) alert('stop failed');
          }}
        >
          Stop
        </button>
      </div>
    </div>
  );
}
