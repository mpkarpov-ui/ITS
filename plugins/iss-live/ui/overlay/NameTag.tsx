// Bottom-left description card with a radial dim gradient. Content from the
// NameTag global, visibility from OverlayVisibility.tag.

import { useNameTagValue, useOverlayVisibility } from './globals';

export function NameTag() {
  const vis = useOverlayVisibility();
  const tag = useNameTagValue();

  const visible = vis.tag;
  const spotFade = visible ? 'target-spot-fade-in' : 'target-spot-fade-out';
  const titleFade = visible ? 'target-title-fade-in' : 'target-title-fade-out';
  const subtitleFade = visible ? 'target-subtitle-fade-in' : 'target-subtitle-fade-out';

  return (
    <div className="stream-target-wrapper">
      <div className={`stream-target-dim-overlay start-hidden ${spotFade}`} />
      <div className={`start-hidden stream-target-desc-title ${titleFade}`}>
        {tag.title.toUpperCase()}
      </div>
      <div className={`start-hidden stream-target-desc-subtitle ${subtitleFade}`}>
        {tag.subtitle}
      </div>
    </div>
  );
}
