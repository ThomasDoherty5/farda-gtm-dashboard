import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OperationsScope } from "../operations.ts";
import { digest } from "../config.ts";
import { boundedSourceRead } from "../actions/readBoundary.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { createSourcingPlanReader, type SourcingPlanReadResult } from "./reader.ts";
import { SourcingError } from "./source.ts";
import { nativeSourcingBindingSchema, nativeSourcingRequestSchema, nativeSourcingSnapshotSchema, NativeSourcingError, type NativeSourcingSource, type NativeSourcingSnapshot } from "./nativeSource.ts";
import { nativeSourcingPlanSchema, type NativeSourcingPlan } from "./views.ts";
import { analyticsPrincipalSchema, analyticsScopeSchema } from "../analytics/contract.ts";

export { NativeSourcingError } from "./nativeSource.ts";
export type NativeSourcingReaderOptions = { db: DatabaseSync; scope: OperationsScope; referenceKey: string; source?: NativeSourcingSource; now?: () => number; timeoutMs?: number };
export type NativeSourcingReadResult = Omit<SourcingPlanReadResult, "data"> & { data: NativeSourcingPlan; assertCurrent(): void };
const fail = (code: string, status = 503): never => { throw new NativeSourcingError(code, status); };
const freeze = <T>(value: T): T => { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; };
const denied = (error: unknown): 401 | 403 | null => error && typeof error === "object" && "status" in error && (error.status === 401 || error.status === 403) ? error.status : null;
export function createNativeSourcingReader(options: NativeSourcingReaderOptions) {
  const scope = freeze(analyticsScopeSchema.parse(structuredClone(options.scope))), source = options.source, timeoutMs = options.timeoutMs ?? 10_000;
  if (options.referenceKey.length < 32 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) return fail("SOURCING_CONFIGURATION_INVALID", 500);
  const now = () => { const value = (options.now ?? Date.now)(); if (!Number.isSafeInteger(value)) return fail("SOURCING_CONFIGURATION_INVALID", 500); return value; };
  const alias = (kind: string, value: string) => `sourcing-${kind}-${createHmac("sha256", options.referenceKey).update(JSON.stringify(["sourcing-native.v1", scope, kind, value])).digest("hex")}`;
  async function read(input: unknown, principalInput: unknown, signal?: AbortSignal): Promise<NativeSourcingReadResult> {
    const parsed = nativeSourcingRequestSchema.safeParse(input), principal = analyticsPrincipalSchema.safeParse(principalInput);
    if (!parsed.success) return fail("SOURCING_REQUEST_INVALID", 400);
    if (!principal.success) return fail("SOURCING_SOURCE_DENIED", 403);
    if (!source) return fail("SOURCING_SOURCE_UNCONFIGURED");
    const binding = freeze(nativeSourcingBindingSchema.parse({ scope, principal: principal.data, request: parsed.data }));
    const controller = new AbortController();
    let raw: unknown;
    try { raw = await boundedSourceRead(() => source.read(binding, controller.signal), signal, timeoutMs); }
    catch (error) {
      if (error instanceof NativeSourcingError) throw new NativeSourcingError(error.code, error.status);
      const status = denied(error); if (status) return fail("SOURCING_SOURCE_DENIED", status);
      if (error && typeof error === "object" && "code" in error && error.code === "REQUEST_CANCELLED") return fail("SOURCING_REQUEST_CANCELLED", 499);
      if (error && typeof error === "object" && "code" in error && error.code === "SOURCE_READ_TIMEOUT") return fail("SOURCING_SOURCE_TIMEOUT", 504);
      return fail("SOURCING_SOURCE_UNAVAILABLE");
    } finally { controller.abort(); }
    if (raw === null) return fail("SOURCING_SOURCE_UNAVAILABLE");
    const parsedSnapshot = nativeSourcingSnapshotSchema.safeParse(raw);
    if (!parsedSnapshot.success) return fail("SOURCING_SOURCE_INVALID");
    const snapshot: NativeSourcingSnapshot = freeze(structuredClone(parsedSnapshot.data));
    let publicationDeadline = Infinity, persisted = false;
    const { observedAt: _observed, validUntil: _until, ...stableFacts } = snapshot.snapshot;
    void _observed; void _until;
    const factsHash = digest(stableFacts);
    const assertCurrent = () => {
      if (signal?.aborted) return fail("SOURCING_REQUEST_CANCELLED", 499);
      const at = now();
      if (digest(snapshot.binding) !== digest(binding) || digest(snapshot.snapshot.scope) !== digest(scope) || snapshot.sourceVersion !== snapshot.snapshot.version) return fail("SOURCING_BINDING_MISMATCH", 403);
      if (Date.parse(snapshot.observedAt) > at || Date.parse(snapshot.snapshot.observedAt) > Date.parse(snapshot.observedAt) || at >= Date.parse(snapshot.validUntil) || at - Date.parse(snapshot.observedAt) >= 15 * 60_000 || at >= publicationDeadline) return fail("SOURCING_PUBLICATION_EXPIRED", 409);
      if (typeof source.assertCurrent !== "function") return fail("SOURCING_SOURCE_FENCE_UNAVAILABLE");
      if (persisted) {
        const head = options.db.prepare("SELECT version FROM sourcing_plan_source_head WHERE id=1").get();
        const version = options.db.prepare("SELECT facts_hash FROM sourcing_plan_source_versions WHERE version=?").get(snapshot.sourceVersion);
        if (head?.version !== snapshot.sourceVersion || version?.facts_hash !== factsHash) return fail("SOURCING_SOURCE_CHANGED", 409);
      }
      try { assertSynchronousVoid(() => source.assertCurrent(snapshot, binding, at)); }
      catch (error) { if (error instanceof NativeSourcingError) throw new NativeSourcingError(error.code, error.status); const status = denied(error); if (status) return fail("SOURCING_SOURCE_DENIED", status); return fail("SOURCING_SOURCE_CHANGED", 409); }
    };
    assertCurrent();
    const at = now(), s = snapshot.snapshot;
    const boundaries = [Date.parse(snapshot.validUntil), Date.parse(snapshot.observedAt) + 15 * 60_000, Date.parse(s.validUntil), Date.parse(s.observedAt) + 26 * 3_600_000,
      ...s.capacity.flatMap(row => [row.validUntil, row.resetAt].filter((value): value is string => value !== null).map(value => Date.parse(value))), ...(s.schedule.nextRunAt ? [Date.parse(s.schedule.nextRunAt)] : [])];
    publicationDeadline = Math.min(...boundaries.filter(value => value > at));
    // The preserved PR89 tables only bind source version to immutable material. No plan, dispatch or provider ledger is added.
    const projection = createSourcingPlanReader({ db: options.db, scope, secret: options.referenceKey, source: async () => { assertCurrent(); return snapshot.snapshot; }, now, sourceTimeoutMs: timeoutMs, assertCurrent });
    let result: SourcingPlanReadResult;
    try { result = await projection.read({}, binding.principal.role); }
    catch (error) { if (error instanceof NativeSourcingError) throw new NativeSourcingError(error.code, error.status); if (error instanceof SourcingError && error.code === "SOURCE_VERSION_CHANGED") return fail("SOURCING_SOURCE_CHANGED", 409); return fail("SOURCING_SOURCE_INVALID"); }
    persisted = true;
    assertCurrent();
    const sourcePlan = result.data.plan;
    const plan = sourcePlan ? { ...sourcePlan, icpVersion: s.icpVersion ? `version-${alias("version", s.icpVersion).slice(-64)}` : null, policyVersion: s.policyVersion ? `version-${alias("version", s.policyVersion).slice(-64)}` : null } : null;
    const data = nativeSourcingPlanSchema.parse({ ...result.data, plan, datasetKey: "sourcing-plan-native", provenance: { evidenceStage: snapshot.evidenceStage, synthetic: snapshot.synthetic, sourceVersion: alias("version", snapshot.sourceVersion), observedAt: snapshot.observedAt, validUntil: new Date(publicationDeadline).toISOString() } });
    const response = { ...result, data, version: `sourcing-v1-${digest([binding, snapshot, data])}`, assertCurrent };
    assertCurrent();
    return response;
  }
  return { read };
}
