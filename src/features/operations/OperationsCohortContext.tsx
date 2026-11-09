import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { scopeKey, useScope } from "@/adapter/scope";
import type { OperationsReportingScope } from "@/adapter/viewSchemas/nativeOperations";

type Registration = { identity: string; owner: symbol; cohort: OperationsReportingScope };
type ContextValue = { cohort: OperationsReportingScope | null; register: (cohort: OperationsReportingScope) => () => void };
const Context = createContext<ContextValue>({ cohort: null, register: () => () => undefined });

/** Only a mounted, leased source body registers a cohort. No fetch or URL-derived authority. */
export function OperationsCohortProvider({ children }: { children: ReactNode }) {
  const scope = useScope();
  const identity = JSON.stringify(scopeKey(scope));
  const [entry, setEntry] = useState<Registration | null>(null);
  const register = useCallback((cohort: OperationsReportingScope) => {
    const owner = Symbol("operations-source-body");
    setEntry({ identity, owner, cohort });
    return () => setEntry(current => current?.owner === owner ? null : current);
  }, [identity]);
  const cohort = entry?.identity === identity ? entry.cohort : null;
  const value = useMemo(() => ({ cohort, register }), [cohort, register]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useOperationsCohort = () => useContext(Context);
export function useRegisterOperationsCohort(cohort: OperationsReportingScope | null | undefined) {
  const { register } = useOperationsCohort();
  const home=cohort?.home,startAt=cohort?.startAt,endAt=cohort?.endAt,timezone=cohort?.timezone,basis=cohort?.basis;
  // Callers may reconstruct an equivalent source cohort on render. Register only material changes,
  // while retaining this registration's owner-specific cleanup and authenticated scope identity.
  useEffect(() => home&&startAt&&endAt&&timezone&&basis ? register({home,startAt,endAt,timezone,basis}) : undefined,
    [home,startAt,endAt,timezone,basis,register]);
}
