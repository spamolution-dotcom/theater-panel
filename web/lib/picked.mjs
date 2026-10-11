// Tap feedback for the scene buttons: the tapped scene lights up straight away and stays lit until
// Home Assistant reports it (the cinema can take a few seconds to say so, longer from cold), or for
// 60 s if it never does, after which the buttons show what HA says again.
import { useState, useEffect } from 'preact/hooks';

export function usePicked(active) {
  const [picked, setPicked] = useState(null);
  useEffect(() => { if (picked && active === picked) setPicked(null); }, [active, picked]);
  useEffect(() => { if (!picked) return undefined; const t = setTimeout(() => setPicked(null), 60000); return () => clearTimeout(t); }, [picked]);
  return [picked || active, setPicked];
}
