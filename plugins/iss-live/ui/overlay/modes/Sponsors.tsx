// Sponsor rotator. Text-only: the format YAML has no asset refs yet, so this
// renders names rather than the legacy PNG logos.

import { useEffect, useState } from 'preact/hooks';

interface Props {
  sponsors: string[];
}

const HOLD_MS = 7_000;
const FADE_MS = 2_000;

export function SponsorsScreen({ sponsors }: Props) {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (sponsors.length === 0) return;
    const id = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIndex((i) => (i + 1) % sponsors.length);
        setVisible(true);
      }, FADE_MS);
    }, HOLD_MS + FADE_MS);
    return () => clearInterval(id);
  }, [sponsors.length]);

  if (sponsors.length === 0) {
    return (
      <div className="sponsor-rotator">
        <div className="sponsor-header">No sponsors in this format</div>
      </div>
    );
  }

  return (
    <div className="sponsor-rotator">
      <div className="sponsor-header">Sponsors</div>
      <div className="sponsor-box">
        <span className={visible ? 'fact-in' : 'fact-out'} style={{ color: '#fff', fontFamily: '"Trebuchet MS", sans-serif', fontSize: '2rem' }}>
          {sponsors[index]}
        </span>
      </div>
    </div>
  );
}
