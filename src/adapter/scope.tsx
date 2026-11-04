import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { onlineManager, useQueryClient } from "@tanstack/react-query";
import type { FardaAdapter } from "./adapter";
import type { RequestedScope } from "./contract";

type ScopeValue = { adapter: FardaAdapter; scope: RequestedScope; principal: string };
const ScopeContext = createContext<ScopeValue | null>(null);

/** Root of every protected query key. Changing scope drops the previous scope's cached data. */
export function scopeKey(v: Pick<ScopeValue, "principal" | "scope">) {
  return ["farda", v.principal, v.scope.environment, v.scope.workspaceId, [...v.scope.accountIds].sort().join(",")] as const;
}

export function ScopeProvider({ adapter, scope, principal, children }: ScopeValue & { children: ReactNode }) {
  const client = useQueryClient();
  const value = useMemo(() => ({ adapter, scope, principal }), [adapter, scope, principal]);
  const previous = useRef<readonly unknown[] | null>(null);
  useEffect(() => {
    const key = scopeKey(value);
    if (previous.current && JSON.stringify(previous.current) !== JSON.stringify(key)) {
      void client.cancelQueries({ queryKey: previous.current });
      client.removeQueries({ queryKey: previous.current });
    }
    previous.current = key;
  }, [client, value]);
  // Connectivity returning refetches this scope's active reads, fresh or not: figures shown while offline were not current.
  // A 401/403 on that refetch still clears protected data (useView).
  useEffect(() => {
    let wasOnline = onlineManager.isOnline();
    return onlineManager.subscribe((online) => {
      if (online && !wasOnline) void client.invalidateQueries({ queryKey: scopeKey(value) });
      wasOnline = online;
    });
  }, [client, value]);
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeValue {
  const v = useContext(ScopeContext);
  if (!v) throw new Error("useScope must be used inside ScopeProvider");
  return v;
}
