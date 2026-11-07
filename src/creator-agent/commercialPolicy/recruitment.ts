import { createHmac } from "node:crypto";
import { z } from "zod";
import { digest } from "../config.ts";
import { routeId } from "../offers/contract.ts";
import { offerPhaseSchema } from "../offers/policy.ts";
import { commercialInstant, commercialRef, commercialScopeSchema, type CommercialScope } from "./contract.ts";
import { sameCommercialScope } from "./authority.ts";

export const recruitmentFiltersSchema = z.object({ networks: z.enum(["both", "instagram", "tiktok"]).default("both"), route: z.enum(["queue", "inbound", "outbound"]).default("queue") }).strict();
export type RecruitmentFilters = z.infer<typeof recruitmentFiltersSchema>;
export const recruitmentSourceSnapshotSchema = z.object({ scope: commercialScopeSchema, principalRef: commercialRef, filters: recruitmentFiltersSchema,
  sourceRef: commercialRef, sourceVersion: commercialRef, observedAt: commercialInstant, validUntil: commercialInstant,
  permission: z.enum(["permitted", "denied", "unknown"]),
  rows: z.array(z.object({ opportunityRef: commercialRef, creatorId: commercialRef, runId: commercialRef.nullable(),
    offerId: routeId.nullable(), offerVersion: z.string().regex(/^v[1-9]\d*$/).nullable(), phase: offerPhaseSchema,
    network: z.enum(["instagram", "tiktok", "unknown"]), route: z.enum(["inbound", "outbound", "unknown"]) }).strict()).max(100),
  total: z.number().int().nonnegative().safe().nullable(), complete: z.boolean(),
}).strict().superRefine((s, ctx) => {
  if (new Set(s.rows.map(row => row.opportunityRef)).size !== s.rows.length || s.total !== null && s.total < s.rows.length || s.complete && s.total !== s.rows.length ||
    s.rows.some(row => row.offerId === null && row.offerVersion !== null)) ctx.addIssue({ code: "custom", message: "Exact recruitment membership and bounded coverage must reconcile." });
});
export type RecruitmentSourceSnapshot = z.infer<typeof recruitmentSourceSnapshotSchema>;
/** Qualified source membership, not a query over scores or the latest creator offer. No write methods. */
export interface RecruitmentSource {
  read(input: { scope: CommercialScope; principalRef: string; filters: RecruitmentFilters; limit: number }): Promise<unknown>;
  assertCurrent(snapshot: RecruitmentSourceSnapshot, now: number): void;
}
export class RecruitmentSourceError extends Error {
  readonly code: string; readonly status: number; readonly executionCertainty = "notApplied" as const;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; this.name = "RecruitmentSourceError"; }
}
export function createRecruitmentSourceReader(options: { scope: CommercialScope; source?: RecruitmentSource; secret: string; now?: () => number }) {
  const scope = commercialScopeSchema.parse(structuredClone(options.scope)), source = options.source, now = options.now ?? Date.now;
  const fail = (code: string, status: number): never => { throw new RecruitmentSourceError(code, status); };
  const alias = (kind: string, value: string) => `recruitment-${kind}-${createHmac("sha256", options.secret).update(JSON.stringify({ scope, kind, value })).digest("hex")}`;
  return { alias, async read(filters: RecruitmentFilters, principalRef: string, limit: number) {
    if (!source) return fail("INTEGRATION_PENDING", 503);
    const input = { scope, filters: recruitmentFiltersSchema.parse(filters), principalRef: commercialRef.parse(principalRef), limit: z.number().int().min(1).max(100).parse(limit) };
    let raw: unknown;
    try { raw = await source.read(structuredClone(input)); } catch (error) {
      if (error instanceof RecruitmentSourceError) throw error;
      return fail("RECRUITMENT_SOURCE_UNAVAILABLE", 503);
    }
    const parsed = recruitmentSourceSnapshotSchema.safeParse(raw);
    if (!parsed.success) return fail("RECRUITMENT_SOURCE_INVALID", 502);
    const snapshot = parsed.data;
    const assertCurrent = () => {
      if (!sameCommercialScope(snapshot.scope, scope) || snapshot.principalRef !== principalRef || digest(snapshot.filters) !== digest(input.filters)) return fail("SOURCE_SCOPE_DENIED", 403);
      if (snapshot.permission === "denied") return fail("SOURCE_SCOPE_DENIED", 403);
      if (snapshot.permission !== "permitted") return fail("RECRUITMENT_PERMISSION_UNVERIFIED", 503);
      const observed = Date.parse(snapshot.observedAt), until = Date.parse(snapshot.validUntil), timestamp = now();
      if (!Number.isSafeInteger(timestamp) || observed > timestamp || until <= timestamp || until <= observed || until - observed > 300_000) return fail("RECRUITMENT_SOURCE_STALE", 409);
      if (snapshot.rows.length > limit || snapshot.rows.some(row => input.filters.networks !== "both" && row.network !== input.filters.networks || input.filters.route !== "queue" && row.route !== input.filters.route)) return fail("RECRUITMENT_SOURCE_INVALID", 502);
      try { source.assertCurrent(structuredClone(snapshot), timestamp); } catch (error) {
        if (error instanceof RecruitmentSourceError) throw error;
        return fail("RECRUITMENT_SOURCE_CHANGED", 409);
      }
    };
    assertCurrent();
    return { snapshot: structuredClone(snapshot), assertCurrent };
  } };
}
