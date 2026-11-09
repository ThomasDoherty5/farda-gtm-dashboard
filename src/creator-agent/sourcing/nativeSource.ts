import { z } from "zod";
import { analyticsPrincipalSchema, analyticsScopeSchema } from "../analytics/contract.ts";
import { instantSchema, refSchema, sourcingPlanFilters } from "./contract.ts";
import { sourcingSnapshotSchema } from "./source.ts";

export const nativeSourcingRequestSchema = z.object({ viewKey: z.literal("sourcingPlan"), filters: sourcingPlanFilters, period: z.null().default(null), sort: z.array(z.never()).length(0).default([]), page: z.object({ cursor: z.null(), limit: z.number().int().min(1).max(500) }).strict().default({ cursor: null, limit: 50 }) }).strict();
export const nativeSourcingBindingSchema = z.object({ scope: analyticsScopeSchema, principal: analyticsPrincipalSchema, request: nativeSourcingRequestSchema }).strict();
export const nativeSourcingSnapshotSchema = z.object({ schemaVersion: z.literal("sourcing-source.v1"), binding: nativeSourcingBindingSchema, sourceVersion: refSchema, permissionVersion: refSchema, observedAt: instantSchema, validUntil: instantSchema,
  evidenceStage: z.enum(["synthetic", "source"]), synthetic: z.boolean(), snapshot: sourcingSnapshotSchema,
}).strict().refine(value => value.synthetic === (value.evidenceStage === "synthetic") && Date.parse(value.validUntil) > Date.parse(value.observedAt));
export type NativeSourcingBinding = z.infer<typeof nativeSourcingBindingSchema>;
export type NativeSourcingSnapshot = z.infer<typeof nativeSourcingSnapshotSchema>;
export type NativeSourcingSource = { read(binding: NativeSourcingBinding, signal: AbortSignal): Promise<unknown | null>; assertCurrent(snapshot: NativeSourcingSnapshot, binding: NativeSourcingBinding, now: number): void };
const codes = new Set(["SOURCING_REQUEST_INVALID", "SOURCING_SOURCE_DENIED", "SOURCING_SOURCE_CHANGED", "SOURCING_SOURCE_INVALID", "SOURCING_BINDING_MISMATCH", "SOURCING_SOURCE_UNCONFIGURED", "SOURCING_SOURCE_UNAVAILABLE", "SOURCING_SOURCE_FENCE_UNAVAILABLE", "SOURCING_PUBLICATION_EXPIRED", "SOURCING_SOURCE_TIMEOUT", "SOURCING_REQUEST_CANCELLED", "SOURCING_CONFIGURATION_INVALID"]);
export class NativeSourcingError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 503) { const known = codes.has(code), safe = known ? code : "SOURCING_SOURCE_UNAVAILABLE"; super(safe); this.code = safe; this.status = known && [400, 401, 403, 409, 499, 500, 503, 504].includes(status) ? status : 503; }
}
