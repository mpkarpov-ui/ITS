// Fun-facts cycler: random start, hold ~13s, fade out 2s, swap, fade in.
// `size` controls the type scale: 'large' for the standalone facts mode,
// 'panel' for embedding inside the pre/idle interstitial side panel.

import { useEffect, useState } from 'preact/hooks';

interface Props {
  facts: string[];
  size?: 'large' | 'panel';
}

const HOLD_MS = 13_000;
const FADE_MS = 2_000;

export function FactsScreen({ facts, size = 'large' }: Props) {
  const [index, setIndex] = useState(() => facts.length === 0 ? 0 : Math.floor(Math.random() * facts.length));
  const [visible, setVisible] = useState(true);

  const large = size === 'large';
  const containerClass = large
    ? 'stream-idle-funfact-container funfact-center'
    : 'stream-idle-funfact-container';
  const titleClass = large
    ? 'stream-idle-funfact-facttitle fact-title-single-large'
    : 'stream-idle-funfact-facttitle';
  const factClass = large
    ? 'stream-idle-funfact-fact fact-single-large'
    : 'stream-idle-funfact-fact';

  useEffect(() => {
    if (facts.length === 0) return;
    const id = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIndex((i) => (i + 1) % facts.length);
        setVisible(true);
      }, FADE_MS);
    }, HOLD_MS + FADE_MS);
    return () => clearInterval(id);
  }, [facts.length]);

  if (facts.length === 0) {
    return (
      <div className={containerClass}>
        <div className={titleClass}>
          No fun facts in this format
        </div>
      </div>
    );
  }

  return (
    <div className={containerClass}>
      <div className={titleClass}>
        Fun facts:
      </div>
      <div className={factClass}>
        <span className={visible ? 'fact-in' : 'fact-out'}>
          {facts[index]}
        </span>
      </div>
    </div>
  );
}
