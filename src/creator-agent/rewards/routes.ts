import { z } from "zod";
import { AgentConflict } from "../store.ts";
import { ref } from "./contract.ts";
import { RewardRedemptionRepository, RewardPurchaseUnknown, RewardSourceUnavailable } from "./repository.ts";

type Input = { method: string; path: string; role: "reviewer" | "reader"; body?: unknown; idempotencyKey?: string };
const sourceBody = (field: string) => z.object({ [field]: ref }).strict();

/**
 * Reward redemption routes. Reads: GET /v1/rewards/redemptions/:id and /v1/rewards/entitlements/:ref/redemption.
 * Writes (reviewer): POST /v1/rewards/redemptions, and /:id/decisions, /:id/purchase, /:id/outcomes, /:id/reconciliations.
 */
export async function handleRewardRoute(input: Input, repo: RewardRedemptionRepository) {
  const url = new URL(input.path, "http://localhost");
  if (!url.pathname.startsWith("/v1/rewards/")) return null;
  const fail = (status: number, code: string) => ({ status, body: { code, executionCertainty: "notApplied" } });
  const parts = url.pathname.split("/").slice(3).map(decodeURIComponent);
  try {
    if ([...url.searchParams.keys()].length) return fail(400, "INVALID_REWARD_QUERY");
    if (input.method === "GET") {
      const record = parts[0] === "redemptions" && parts.length === 2 ? repo.read(parts[1]!)
        : parts[0] === "entitlements" && parts.length === 3 && parts[2] === "redemption" ? repo.activeFor(parts[1]!) : undefined;
      if (record === undefined) return fail(404, "UNSUPPORTED_OPERATION");
      return record ? { status: 200, body: record } : fail(404, "REWARD_RECORD_UNAVAILABLE");
    }
    if (input.method !== "POST") return fail(405, "UNSUPPORTED_METHOD");
    if (input.role !== "reviewer") return fail(403, "REVIEWER_REQUIRED");
    const key = input.idempotencyKey;
    if (!key?.trim() || key.length > 240) return fail(400, "IDEMPOTENCY_KEY_REQUIRED");
    if (parts[0] !== "redemptions") return fail(404, "UNSUPPORTED_OPERATION");
    if (parts.length === 1) return { status: 200, body: repo.prepare(input.body, key) };
    const [, id, action] = parts;
    if (parts.length !== 3 || !id) return fail(404, "UNSUPPORTED_OPERATION");
    if (action === "decisions") return { status: 200, body: repo.decide(id, sourceBody("decisionRef").parse(input.body).decisionRef as string, key) };
    if (action === "purchase") { z.object({}).strict().parse(input.body ?? {}); return { status: 200, body: await repo.purchase(id, key) }; }
    if (action === "outcomes") return { status: 200, body: repo.recordOutcome(id, sourceBody("sourceRef").parse(input.body).sourceRef as string, key) };
    if (action === "reconciliations") return { status: 200, body: repo.reconcile(id, sourceBody("cashRef").parse(input.body).cashRef as string, key) };
    return fail(404, "UNSUPPORTED_OPERATION");
  } catch (error) {
    if (error instanceof RewardPurchaseUnknown) return {status:409,body:{code:error.message,executionCertainty:"uncertain"}};
    if (error instanceof z.ZodError) return fail(422, "INVALID_REWARD_REQUEST");
    if (error instanceof AgentConflict) return fail(409, error.message);
    if (error instanceof RewardSourceUnavailable) return fail(503, error.message);
    throw error;
  }
}
