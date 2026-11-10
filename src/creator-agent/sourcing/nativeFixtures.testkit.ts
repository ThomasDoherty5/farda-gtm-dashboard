import type { DatabaseSync } from "node:sqlite";
import type { OperationsScope } from "../operations.ts";
import { digest } from "../config.ts";
import { createNativeSourcingReader } from "./nativeReader.ts";
import { NativeSourcingError, type NativeSourcingSnapshot, type NativeSourcingSource } from "./nativeSource.ts";
import { completeSourcingFixture, sourcingTestScope, sourcingTestSecret, sourcingTestTime } from "./fixtures.testkit.ts";

/** Fictional source authority; this does not configure or run J19. */
type FixtureOptions = { now?: () => number; principalRef?: string; scope?: OperationsScope };
export function nativeSourcingSourceFixture(options: FixtureOptions = {}) {
  const state = { now: sourcingTestTime, version: "fictional-plan-v1", permissionVersion: "fictional-grant-v1", allowed: true, mutate: null as ((value: NativeSourcingSnapshot) => void) | null, afterRead: null as (() => void | Promise<void>) | null };
  const clock = options.now ?? (() => state.now), scope = options.scope ?? sourcingTestScope, referenceKey = sourcingTestSecret, principal = { principalRef: options.principalRef ?? "agent-reviewer", role: "reviewer" as const };
  const sourceTime = clock(); // Business facts are immutable; access-grant observations may refresh.
  const source: NativeSourcingSource = {
    async read(binding) {
      const at = clock(), source = completeSourcingFixture(scope, sourceTime);
      const result: NativeSourcingSnapshot = { schemaVersion: "sourcing-source.v1", binding: structuredClone(binding), sourceVersion: state.version, permissionVersion: state.permissionVersion, observedAt: new Date(at).toISOString(), validUntil: new Date(at + 60_000).toISOString(), evidenceStage: "synthetic", synthetic: true, snapshot: { ...source, version: state.version } };
      state.mutate?.(result); await state.afterRead?.(); return result;
    },
    assertCurrent(snapshot, binding) {
      if (!state.allowed) throw new NativeSourcingError("SOURCING_SOURCE_DENIED", 403);
      if (snapshot.sourceVersion !== state.version || snapshot.permissionVersion !== state.permissionVersion || digest(snapshot.binding) !== digest(binding)) throw new NativeSourcingError("SOURCING_SOURCE_CHANGED", 409);
    },
  };
  return { state, scope, referenceKey, principal, source, now: clock, request: { viewKey: "sourcingPlan", filters: {}, period: null, sort: [], page: { cursor: null, limit: 50 } } };
}

export function nativeSourcingFixture(db: DatabaseSync, options: FixtureOptions = {}) {
  const fixture = nativeSourcingSourceFixture(options);
  return { ...fixture, reader: createNativeSourcingReader({ db, scope: fixture.scope, referenceKey: fixture.referenceKey, source: fixture.source, now: fixture.now }) };
}
