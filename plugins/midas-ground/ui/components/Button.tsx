// Ported from GSS's Button.jsx. Swallows the click when disabled.

import type { ComponentChildren } from 'preact';
import './Button.css';

type Variant = 'red' | 'yellow' | 'blue' | 'default';

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled = false,
}: {
  children: ComponentChildren;
  onClick: () => void;
  variant?: Variant;
  disabled?: boolean;
}) {
  return (
    <div
      class={`cmd-button cmd-button-${variant} ${disabled ? 'cmd-button-disabled' : ''}`}
      onClick={disabled ? undefined : onClick}
    >
      {children}
    </div>
  );
}
