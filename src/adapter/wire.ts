/**
 * Wire shapes the live adapter validates that `contract.ts` does not define yet. PROPOSED, with the contract: THO-283 freezes them.
 * See docs/live-adapter.md. They are kept here so `contract.ts` keeps its meaning until the freeze.
 */
import { z } from "zod";
import { verifiedScopeSchema } from "./contract";

/** Mirrors `AdapterErrorBody` in errors.ts. */
export const adapterErrorBodySchema = z.object({
  code: z.string().min(1),
  message: z.string().optional(),
  requestId: z.string().nullable().optional(),
  correlationId: z.string().nullable().optional(),
  retryable: z.boolean().optional(),
  retryAfterMs: z.number().nullable().optional(),
  fieldErrors: z.record(z.string()).optional(),
  currentVersion: z.string().nullable().optional(),
  executionCertainty: z.enum(["notApplied", "uncertain", "applied"]).optional(),
});
export type WireErrorBody = z.infer<typeof adapterErrorBodySchema>;

/** Mirrors `SaveResourceResponse` in contract.ts, which exports only the type. */
export const saveResourceResponseSchema = z.object({
  schemaVersion: z.string(),
  requestId: z.string(),
  scope: verifiedScopeSchema,
  resourceRef: z.string(),
  resourceVersion: z.string(),
  persistedAt: z.string(),
  persistedByRef: z.string(),
  record: z.unknown(),
  reasonCodes: z.array(z.string()),
});
