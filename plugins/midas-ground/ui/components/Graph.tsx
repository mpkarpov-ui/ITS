// Live line graph over chart.js: takes a subject + window depth, reads history
// off the shared bridge, renders an updating chart with zoom/pan.

import { useEffect, useMemo, useRef } from 'preact/hooks';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import zoomPlugin from 'chartjs-plugin-zoom';
import type { SubjectUnion, SubjectPayload } from '@its/contracts/_subjects';
import { useHistory, useSetting } from '@its/sdk-react';
import type { UnitFormatter } from '../units';
import './Graph.css';

// Chart.js options take plain color strings, not var(), so resolve the CSS
// custom property at build time. Re-runs on lightMode change (see useMemo deps).
function resolveVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return v.trim() || fallback;
}

ChartJS.register(
  CategoryScale,
  LinearScale,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  Legend,
  zoomPlugin,
);

type Channel<S extends SubjectUnion> = {
  // Typed against the subject's payload so a typo fails the build.
  field: keyof SubjectPayload<S> & string;
  label: string;
  color: string;
};

type Props<S extends SubjectUnion> = {
  subject: S;
  channels: Channel<S>[];
  yLabel: string;
  // Static axis unit for data already in display units (dBm, V).
  unit?: string;
  // Reactive converting formatter; supersedes `unit`. Points pass through
  // convert() before plotting. Pass useUnits().altitude etc.
  unitFormatter?: UnitFormatter;
  depth?: number;
};

export function Graph<S extends SubjectUnion>({
  subject,
  channels,
  yLabel,
  unit = '',
  unitFormatter,
  depth = 200,
}: Props<S>) {
  const history = useHistory(subject, depth);
  const chartRef = useRef(null);
  // Theme dep so chart.js options re-resolve when light/dark flips.
  const [lightMode] = useSetting<boolean>('global', 'lightMode', false);

  // No formatter: convert is identity and the static `unit` prop drives the label.
  const effectiveUnit = unitFormatter ? unitFormatter.unit : unit;
  const convert = unitFormatter ? unitFormatter.convert : (v: number) => v;

  const data = useMemo(
    () => ({
      labels: history.map((_, i) => i),
      datasets: channels.map((ch) => ({
        label: ch.label,
        data: history.map((row) =>
          convert(Number((row as Record<string, unknown>)[ch.field] ?? 0)),
        ),
        borderColor: ch.color,
        backgroundColor: ch.color,
        pointRadius: 0,
        borderWidth: 1.5,
        tension: 0.15,
      })),
    }),
    [history, channels, convert],
  );

  const options = useMemo(() => {
    // Low-alpha rgba grid, not --border-dim, which read too solid in dark mode.
    const gridColor = lightMode
      ? 'rgba(0, 0, 0, 0.08)'
      : 'rgba(255, 255, 255, 0.05)';
    const tickColor = resolveVar('--text-muted', '#888');
    const titleColor = resolveVar('--text-dim', '#aaa');
    // --text-dim, not --text, so the legend doesn't out-shout the channel lines.
    const legendColor = resolveVar('--text-dim', '#a0a0a8');
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false as const,
      scales: {
        x: {
          ticks: { color: tickColor, maxTicksLimit: 6 },
          grid: { color: gridColor },
        },
        y: {
          title: {
            display: true,
            text: effectiveUnit ? `${yLabel} (${effectiveUnit})` : yLabel,
            color: titleColor,
            font: { size: 12 },
          },
          ticks: { color: tickColor },
          grid: { color: gridColor },
        },
      },
      plugins: {
        legend: {
          labels: { color: legendColor, boxWidth: 12, font: { size: 11 } },
        },
        zoom: {
          pan: { enabled: true, mode: 'x' as const },
          zoom: {
            // Ctrl-required so plain wheel scroll passes through to the page
            // instead of trapping focus on the graph.
            wheel: { enabled: true, modifierKey: 'ctrl' as const },
            pinch: { enabled: true },
            mode: 'x' as const,
          },
        },
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yLabel, effectiveUnit, lightMode]);

  // Cleanup-only effect so chart.js tears down on unmount.
  useEffect(() => () => undefined, []);

  return (
    <div class="graph-container">
      <Line ref={chartRef} data={data} options={options} />
    </div>
  );
}
