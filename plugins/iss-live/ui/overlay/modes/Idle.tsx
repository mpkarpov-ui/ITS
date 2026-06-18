// Full-screen pre / idle / goodbye interstitials, ported from the legacy GSS
// stream overlays: full-bleed mission photo, translucent blurred side panel,
// headline + T-clock + subtitle, and a rotating fun-facts panel, with footer
// branding pinned to the bottom. Goodbye swaps the facts for the recovery
// blurb plus social handles and drops the clock. The background photo and all
// mission text come from the active format's idle_screen block, so the plugin
// stays mission-agnostic; missing fields fall back to the legacy defaults.

import { useActiveFormat } from '../../formats/useFormat';
import { useIdleTextValue } from '../globals';
import { CountdownTimer } from '../CountdownTimer';
import { FactsScreen } from './Facts';
import type { IdleScreenConfig } from '../../formats/types';

interface Props {
  variant: 'idle' | 'pre' | 'goodbye';
}

const DEFAULT_HEADLINE: Record<Props['variant'], string> = {
  pre: 'Starting soon!',
  idle: "We'll be back soon!",
  goodbye: 'Thank You!',
};

const DEFAULT_GOODBYE_TEXT =
  'The team is now beginning the rocket recovery process. Stay updated by following our social media!';

export function IdleScreen({ variant }: Props) {
  const { format } = useActiveFormat();
  const idle = useIdleTextValue();
  const cfg: IdleScreenConfig = format?.idle_screen ?? {};
  const facts = format?.fun_facts ?? [];

  const headline =
    (variant === 'pre' && cfg.headline_pre) ||
    (variant === 'idle' && cfg.headline_idle) ||
    (variant === 'goodbye' && cfg.headline_goodbye) ||
    DEFAULT_HEADLINE[variant];

  const background = variant === 'pre' ? cfg.pre_background : cfg.idle_background;
  const wrapClass = variant === 'pre' ? 'stream-pre-text-wrap' : 'stream-idle-text-wrap';
  const bgStyle = background ? { backgroundImage: `url("${background}")` } : undefined;

  return (
    <div className="stream-idle-photo-bg" style={bgStyle}>
      <div className={wrapClass}>
        <div className="stream-idle-header">
          <div className="stream-idle-title">{headline}</div>
          {variant !== 'goodbye' && (
            <div className="stream-idle-timer">
              T<CountdownTimer digitMode={4} anim={false} />
            </div>
          )}
          {cfg.subtitle && <div className="stream-idle-subtext">{cfg.subtitle}</div>}
        </div>

        {variant === 'goodbye' ? (
          <div className="stream-idle-funfact-container">
            <div className="stream-idle-goodbye-text">
              {cfg.goodbye_text ?? DEFAULT_GOODBYE_TEXT}
            </div>
            {(cfg.social_handles ?? []).map((s) => (
              <div className="stream-idle-mediahandle-wrap" key={`${s.platform}-${s.handle}`}>
                <span className="stream-idle-mediahandle">{s.handle}</span> on {s.platform}
              </div>
            ))}
          </div>
        ) : (
          <FactsScreen facts={facts} size="panel" />
        )}

        {variant === 'idle' && idle.reason_text && (
          <div className="stream-idle-reason">{idle.reason_text}</div>
        )}

        {(cfg.footer_top || cfg.footer_bottom) && (
          <div className="stream-idle-footer">
            {cfg.footer_top && <div className="stream-idle-footer-t">{cfg.footer_top}</div>}
            {cfg.footer_bottom && <div className="stream-idle-footer-b">{cfg.footer_bottom}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
