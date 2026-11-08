import { useEffect, useState, useSyncExternalStore } from "react";

const noSubscription = () => () => {};
/**
 * Evaluates a wall-clock check on every render; it must return a primitive. The clock is read as an external-store snapshot rather than
 * by an impure call in the render body; timers that re-render at a lease boundary stay with the caller.
 */
export function useClockCheck<T extends string | number | boolean | null>(check: (now: number) => T): T {
  return useSyncExternalStore(noSubscription, () => check(Date.now()));
}

/** Expiry removes a display claim; it never renews a source grant or evaluates business policy. */
export function useSourceLease(validUntil: string | null | undefined): boolean {
  const [tick, setTick] = useState(0);
  const expiry = validUntil ? Date.parse(validUntil) : NaN;
  useEffect(() => {
    const delay = expiry - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = setTimeout(() => setTick(value => value + 1), Math.min(delay + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [expiry, tick]);
  return useClockCheck(now => Number.isFinite(expiry) && expiry > now);
}
