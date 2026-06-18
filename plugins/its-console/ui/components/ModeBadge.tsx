import './ModeBadge.css';

export function ModeBadge({ mode }: { mode: 'constrained' | 'full' }) {
  const label = mode === 'constrained' ? 'ITS-ONLY' : 'FULL EXEC';
  return <span class={`mode-badge mode-badge-${mode}`}>{label}</span>;
}
