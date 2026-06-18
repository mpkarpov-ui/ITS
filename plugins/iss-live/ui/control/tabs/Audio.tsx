// Per-input mute toggles over obs.inputs; click a chip to flip mute.

import type { JSX } from 'preact';
import { useObs } from '../../services/useObs';
import { obsService } from '../../services/obs';
import { ChipButton, Empty, Panel } from '../ui';

export function AudioTab() {
  const obs = useObs();

  if (!obs.connected) {
    return (
      <Panel label="Audio">
        <Empty>OBS not connected</Empty>
      </Panel>
    );
  }

  const audioInputs = Object.entries(obs.inputs).filter(([, info]) => info.muted !== undefined);

  return (
    <Panel label={`Audio Inputs (${audioInputs.length})`}>
      {audioInputs.length === 0 ? (
        <Empty>No audio inputs discovered from OBS</Empty>
      ) : (
        <div style={listStyle}>
          {audioInputs.map(([inputName, info]) => (
            <ChipButton
              key={inputName}
              active={!info.muted}
              tone={info.muted ? 'error' : 'live'}
              onClick={() => obsService.setInputMute(inputName, !info.muted).catch((e) => console.warn('[audio]', e))}
            >
              {inputName.replace(/_/g, ' ')} · {info.muted ? 'Muted' : 'On'}
            </ChipButton>
          ))}
        </div>
      )}
    </Panel>
  );
}

const listStyle: JSX.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.4rem',
};
