import { useEffect, useState } from "react";

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
  return Number.isFinite(expiry) && expiry > Date.now();
}
