/**
 * Wire shapes the live adapter validates that `contract.ts` does not define yet. PROPOSED, with the contract: THO-283 freezes them.
 * See docs/live-adapter.md. They are kept here so `contract.ts` keeps its meaning until the freeze.
 */
import { z } from "zod";
import { executionCertaintySchema } from "./contract";

/** The save response schema now lives in contract.ts (D-14, docs/live-adapter.md T-02); re-exported so existing imports keep working. */
export { saveResourceResponseSchema } from "./contract";

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
  reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/)).max(100).optional(),
  rowIndex: z.number().int().min(0).max(99).nullable().optional(),
  /** Q-04 requires it on every write error. It stays optional here so a server that omits it is read as `uncertain` by the live adapter, never as `notApplied`. */
  executionCertainty: executionCertaintySchema.optional(),
});
export type WireErrorBody = z.infer<typeof adapterErrorBodySchema>;
