import { z } from "zod";
import type { OperationsScope } from "../operations.ts";
import { activationAggregateSchema, consentAggregateSchema, flowCatalogSchema, instantSchema, observedCountSchema, refSchema } from "./contract.ts";

/** D-13 order-source ceiling: lifecycle includes checkout/delivery/consent evidence.
 * A provider lease may shorten this limit, but cannot extend server-owned freshness.
 * This does not assert that a remote source remained unchanged after its read.
 */
export const lifecycleMaxObservationAgeMs = 15 * 60_000;
export function lifecycleObservationDeadline(observedAt: string, validUntil: string): string {
  return new Date(Math.min(Date.parse(validUntil), Date.parse(observedAt) + lifecycleMaxObservationAgeMs)).toISOString();
}
export function lifecycleObservationCurrent(observedAt: string, validUntil: string, now: number): boolean {
  return Number.isFinite(now) && Date.parse(observedAt) <= now && Date.parse(lifecycleObservationDeadline(observedAt, validUntil)) > now;
}

/** Read-only J17/provider aggregate boundary. It is not an email executor or an enrollment ledger. */
export const lifecycleSnapshotSchema = z.object({
  scope: z.object({ workspaceId: refSchema, accountId: refSchema, environment: z.literal("sandbox") }).strict(),
  version: refSchema, observedAt: instantSchema, validUntil: instantSchema, coverage: z.enum(["complete", "partial"]),
  flows: z.array(flowCatalogSchema).max(4), consent: consentAggregateSchema.nullable(), activation: activationAggregateSchema.nullable(),
  returnsAwaitingInspection: observedCountSchema,
}).strict().superRefine((s, c) => {
  if (Date.parse(s.validUntil) <= Date.parse(s.observedAt)) c.addIssue({ code: "custom", message: "Invalid source lease." });
  if (new Set(s.flows.map(f => f.flow)).size !== s.flows.length) c.addIssue({ code: "custom", message: "Duplicate source flow." });
  const windows = [s.consent?.cohort, s.activation?.cohort, ...s.flows.map(f => f.outcomes?.cohort)].filter(w => w !== undefined);
  if (windows.some(w => Date.parse(w.end) > Date.parse(s.observedAt))) c.addIssue({ code: "custom", message: "A completed aggregate cannot contain a future window." });
  if (s.flows.some(f => f.evidence.some(e => e.observedAt && Date.parse(e.observedAt) > Date.parse(s.observedAt)))) c.addIssue({ code: "custom", message: "Evidence cannot postdate its source observation." });
});
export type LifecycleSnapshot = z.infer<typeof lifecycleSnapshotSchema>;
export type LifecycleSourceReader = (scope: OperationsScope) => Promise<unknown | null>;

export class LifecycleError extends Error {
  readonly code: string;
  readonly status: number;
  readonly currentVersion?: string;
  readonly fieldErrors?: Record<string, string>;
  readonly executionCertainty: "notApplied" | "uncertain";
  constructor(code: string, status: number, options: { currentVersion?: string; fieldErrors?: Record<string, string>; executionCertainty?: "notApplied" | "uncertain" } = {}) {
    super(code); this.code = code; this.status = status; this.currentVersion = options.currentVersion;
    this.fieldErrors = options.fieldErrors; this.executionCertainty = options.executionCertainty ?? "notApplied";
  }
}
