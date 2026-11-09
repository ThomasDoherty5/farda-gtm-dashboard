import { useEffect, useState } from "react";
import { useClockCheck } from "@/features/commercial/useSourceLease";

/** Read-access leases are independent of business-data freshness. Recheck at the
 * exact deadline and when a suspended tab resumes; never renew authority here. */
export function useSourceLease(validUntil: string | null | undefined) {
  const [, tick] = useState(0);
  const deadline = validUntil == null ? null : Date.parse(validUntil);
  useEffect(() => {
    if (deadline === null || !Number.isFinite(deadline)) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => { const remaining = deadline - Date.now(); if (remaining > 0) timer = setTimeout(check, Math.min(remaining, 2_147_483_647)); };
    const check = () => { clearTimeout(timer); tick(value => value + 1); schedule(); };
    schedule(); window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { clearTimeout(timer); window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, [deadline]);
  return useClockCheck(now => deadline !== null && (!Number.isFinite(deadline) || deadline <= now));
}
