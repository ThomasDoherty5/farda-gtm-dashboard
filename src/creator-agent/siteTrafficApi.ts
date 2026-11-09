import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { approvalScopeSchema } from "./approvals/contract.ts";
import { boundedSourceRead } from "./actions/readBoundary.ts";
import { digest } from "./config.ts";
import { assertSynchronousVoid } from "./sourceFence.ts";
import type { ApiRequestLimits } from "./apiRequestLimits.ts";
import { trafficHashSchema, trafficImportPrincipalSchema, trafficImportRequestSchema, trafficInstantSchema, trafficRefSchema, type TrafficImportRequest } from "./siteTraffic/contract.ts";
import type { createSiteTrafficService } from "./siteTraffic/service.ts";

export const siteTrafficImportCommandSchema = z.object({
  schemaVersion: z.literal("farda.site-traffic-import.v1"),
  requestedScope: approvalScopeSchema,
  input: trafficImportRequestSchema,
}).strict();
export const siteTrafficMachineProofSchema = z.object({
  scope: approvalScopeSchema, principal: trafficImportPrincipalSchema,
  inputHash: trafficHashSchema, proofRef: trafficRefSchema,
  observedAt: trafficInstantSchema, validUntil: trafficInstantSchema,
}).strict();
export type SiteTrafficMachineProof = z.infer<typeof siteTrafficMachineProofSchema>;
export type SiteTrafficImportMachine = {
  token: string;
  principal: z.infer<typeof trafficImportPrincipalSchema>;
  resolve(scope: z.infer<typeof approvalScopeSchema>, input: TrafficImportRequest, signal: AbortSignal): Promise<unknown>;
  assertCurrent(proof: SiteTrafficMachineProof, now: number): void;
};
export class SiteTrafficApiError extends Error {
  readonly executionCertainty = "uncertain" as const;
  readonly code: string;
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(code: string, status: number, retryAfterMs: number | null = null) { super(code); this.code = code; this.status = status; this.retryAfterMs = retryAfterMs; }
}

/** Machine authorization composes the source importer; browser roles cannot supply aggregate data or grants. */
export function createSiteTrafficImportApi(options: {
  scope: z.infer<typeof approvalScopeSchema>;
  service: Pick<ReturnType<typeof createSiteTrafficService>, "importSource">;
  machine?: SiteTrafficImportMachine;
  limits: Pick<ApiRequestLimits, "admit">;
  now?: () => number;
}) {
  const now = options.now ?? Date.now, scope = approvalScopeSchema.parse(options.scope);
  const binding = options.machine;
  const principal = binding ? trafficImportPrincipalSchema.parse(binding.principal) : null;
  if (binding && binding.token.length < 32) throw new Error("Traffic imports require a distinct server-only machine credential.");
  function authenticate(authorization: string | undefined) {
    if (!binding || !principal) throw new SiteTrafficApiError("TRAFFIC_MACHINE_UNCONFIGURED", 503);
    const actual = Buffer.from(authorization ?? ""), expected = Buffer.from(`Bearer ${binding.token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new SiteTrafficApiError("TRAFFIC_MACHINE_REQUIRED", 401);
  }
  async function execute(body: unknown, authorization: string | undefined, signal?: AbortSignal) {
    authenticate(authorization);
    const parsed = siteTrafficImportCommandSchema.safeParse(body);
    if (!parsed.success) throw new SiteTrafficApiError("TRAFFIC_IMPORT_INPUT_INVALID", 422);
    const command = parsed.data;
    if (digest(command.requestedScope) !== digest(scope)) throw new SiteTrafficApiError("TRAFFIC_IMPORT_SCOPE_DENIED", 403);
    const admission = options.limits.admit(principal!.principalRef, "write");
    if (!admission.admitted) throw new SiteTrafficApiError("TRAFFIC_IMPORT_RATE_LIMITED", 429, admission.retryAfterMs);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const dispose = () => { controller.abort(); signal?.removeEventListener("abort", cancel); };
    let publicationPending = false;
    try {
      let resolved: unknown;
      try { resolved = await boundedSourceRead(() => binding!.resolve(structuredClone(scope), structuredClone(command.input), controller.signal), controller.signal); }
      catch { throw new SiteTrafficApiError("TRAFFIC_MACHINE_DENIED", 403); }
      const proofResult = siteTrafficMachineProofSchema.safeParse(resolved);
      if (!proofResult.success) throw new SiteTrafficApiError("TRAFFIC_MACHINE_PROOF_INVALID", 403);
      const proof = proofResult.data, inputHash = digest(command.input);
      const assertCallerCurrent = () => {
        authenticate(authorization);
        const start = Date.parse(proof.observedAt), end = Date.parse(proof.validUntil), time = now();
        if (controller.signal.aborted || digest(binding!.principal) !== digest(principal) || digest(proof.scope) !== digest(scope) || digest(proof.principal) !== digest(principal) || proof.inputHash !== inputHash || start > time || end <= time || end <= start || end - start > 300_000)
          throw new SiteTrafficApiError("TRAFFIC_MACHINE_PROOF_INVALID", 403);
        try { assertSynchronousVoid(() => binding!.assertCurrent(structuredClone(proof), time)); }
        catch { throw new SiteTrafficApiError("TRAFFIC_MACHINE_DENIED", 403); }
        authenticate(authorization);
        if (digest(binding!.principal) !== digest(principal)) throw new SiteTrafficApiError("TRAFFIC_MACHINE_PROOF_INVALID", 403);
      };
      assertCallerCurrent();
      const result = await options.service.importSource(command.input, principal!, { assertCallerCurrent, signal: controller.signal });
      const assertCurrent = () => { assertCallerCurrent(); assertSynchronousVoid(result.assertCurrent); assertCallerCurrent(); };
      assertCurrent();
      publicationPending = true;
      return { receipt: result.receipt, assertCurrent, dispose };
    } finally {
      if (!publicationPending) dispose();
    }
  }
  return { authenticate, execute };
}
