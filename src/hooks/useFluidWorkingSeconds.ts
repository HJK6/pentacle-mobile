import { useEffect, useRef, useState } from 'react';

type AnchorState = {
  base: number;
  baseWall: number;
  floor: number;
};

function sanitizeSeconds(value: number) {
  return Math.max(0, Math.floor(value));
}

export function useFluidWorkingSeconds(anchorSeconds: number | null): number | null {
  const anchorRef = useRef<AnchorState | null>(null);
  const [shownSeconds, setShownSeconds] = useState<number | null>(() => (
    anchorSeconds === null ? null : sanitizeSeconds(anchorSeconds)
  ));

  useEffect(() => {
    if (anchorSeconds === null) {
      anchorRef.current = null;
      setShownSeconds(null);
      return;
    }

    const nextBase = sanitizeSeconds(anchorSeconds);
    const now = Date.now();
    const previous = anchorRef.current;
    const nextFloor = previous === null ? nextBase : Math.max(previous.floor, nextBase);
    const effectiveBase = previous !== null && nextBase < previous.floor - 2 ? previous.floor : nextBase;

    anchorRef.current = {
      base: effectiveBase,
      baseWall: now,
      floor: nextFloor,
    };
    setShownSeconds(nextFloor);

    const tick = () => {
      const anchor = anchorRef.current;
      if (anchor === null) return;
      const elapsed = Math.floor((Date.now() - anchor.baseWall) / 1000);
      const next = Math.max(anchor.floor, anchor.base + elapsed);
      anchor.floor = next;
      setShownSeconds(next);
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [anchorSeconds]);

  return shownSeconds;
}

export default useFluidWorkingSeconds;
