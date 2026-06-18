// Ported from GSS's gss-frontend/src/components/reusable/ValueDisplay.jsx.
// Plugin-local; the platform doesn't ship UI primitives.

import type { ComponentChildren } from 'preact';
import './ValueDisplay.css';

type Single = {
  label: string;
  value: number | string;
  unit?: string;
  hidden?: boolean;
};

export function SingleValue({ label, value, unit = '', hidden = false }: Single) {
  return (
    <div class="value-card">
      {hidden && <div class="card-overlay">NO DATA</div>}
      <div class="value-card-name">{label}</div>
      <div class={hidden ? 'card-hide' : ''}>
        <div class="value-card-display">
          {value}
          <span class="value-card-unit">{unit}</span>
        </div>
      </div>
    </div>
  );
}

type Multi = {
  label: string;
  titles: string[];
  values: (number | string)[];
  units?: string[];
  labelColors?: string[];
  dataColors?: string[];
  hidden?: boolean;
};

export function MultiValue({
  label,
  titles,
  values,
  units,
  labelColors,
  dataColors,
  hidden = false,
}: Multi) {
  const lc = labelColors ?? titles.map(() => '#cccccc');
  const dc = dataColors ?? titles.map(() => '#ffffff');
  const u = units ?? titles.map(() => '');
  return (
    <div class="value-card">
      {hidden && <div class="card-overlay">NO DATA</div>}
      <div class="value-card-name">{label}</div>
      <div class={hidden ? 'card-hide' : ''}>
        <div class="value-card-display-multi">
          {titles.map((title, i) => (
            <div key={i} class="value-card-display-multi-item">
              <div class="shrink-text" style={{ color: lc[i] }}>
                {title}
              </div>
              <div>
                <span style={{ color: dc[i] }}>{values[i]}</span>
                <span class="value-card-unit">{u[i]}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type Group = {
  label: string;
  children: ComponentChildren;
  hidden?: boolean;
  hiddenLabelText?: string;
  smallLabels?: boolean;
};

export function ValueGroup({
  label,
  children,
  hidden = false,
  hiddenLabelText = 'NO DATA',
  smallLabels = false,
}: Group) {
  return (
    <div class={`value-card-group ${smallLabels ? 'value-card-group-smalllabel' : ''}`}>
      {hidden && <div class="card-overlay">{hiddenLabelText}</div>}
      <div class="value-card-gname">{label}</div>
      <div class={hidden ? 'card-hide' : ''}>{children}</div>
    </div>
  );
}

type Status = 'OK' | 'GO' | 'WARN' | 'CAUT' | 'STBY' | 'ERR' | 'NOGO' | 'LOS' | string;

function statusClass(status: Status): string {
  if (status === 'OK' || status === 'GO') return 'status-ok';
  if (status === 'WARN') return 'status-warning';
  if (status === 'CAUT' || status === 'STBY') return 'status-caution';
  if (status === 'ERR' || status === 'NOGO' || status === 'LOS') return 'status-error';
  return 'status-inactive';
}

export function StatusDisplay({ label, status }: { label: string; status: Status }) {
  const cls = statusClass(status);
  return (
    <div class={`status-card card-${cls}`}>
      <div class="status-name">{label}</div>
      <div class={`status-display ${cls}`}>{status.padEnd(4, ' ')}</div>
    </div>
  );
}
