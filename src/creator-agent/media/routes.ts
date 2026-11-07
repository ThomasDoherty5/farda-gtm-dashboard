import { z } from "zod";
import { AgentConflict } from "../store.ts";
import { mutationAuthorizationSchema, ref } from "./contract.ts";
import { MediaSourceUnavailable, PaidMediaRepository } from "./repository.ts";

type Input = { method: string; path: string; role: "reviewer" | "reader"; body?: unknown; idempotencyKey?: string };
const decisionBody = z.object({ decisionRef: ref }).strict();
const emptyBody = z.object({}).strict();

/**
 * Paid-media routes. Reads: GET /v1/media/campaigns/:id, /v1/media/campaigns/:id/mutations/:mutationId and
 * /v1/media/inventories/:provider/:accountRef. Writes (reviewer): POST /v1/media/inventories, /v1/media/campaigns, and
 * /campaigns/:id/native-draft, /:id/decisions, /:id/publish, /:id/mutations, /:id/mutations/:mutationId/apply ({decisionRef} or, for a pause, {policyRef}).
 */
export async function handleMediaRoute(input: Input, repo: PaidMediaRepository) {
  const url = new URL(input.path, "http://localhost");
  if (!url.pathname.startsWith("/v1/media/")) return null;
  const fail = (status: number, code: string) => ({ status, body: { code, executionCertainty: "notApplied" } });
  const parts = url.pathname.split("/").slice(3).map(decodeURIComponent);
  try {
    if ([...url.searchParams.keys()].length) return fail(400, "INVALID_MEDIA_QUERY");
    if (input.method === "GET") {
      const record = parts[0] === "campaigns" && parts.length === 2 ? repo.read(parts[1]!)
        : parts[0] === "campaigns" && parts.length === 4 && parts[2] === "mutations" ? repo.readMutation(parts[1]!, parts[3]!)
        : parts[0] === "inventories" && parts.length === 3 ? repo.latestInventory(parts[1]!, parts[2]!) : undefined;
      if (record === undefined) return fail(404, "UNSUPPORTED_OPERATION");
      return record ? { status: 200, body: record } : fail(404, "MEDIA_RECORD_UNAVAILABLE");
    }
    if (input.method !== "POST") return fail(405, "UNSUPPORTED_METHOD");
    if (input.role !== "reviewer") return fail(403, "REVIEWER_REQUIRED");
    const key = input.idempotencyKey;
    if (!key?.trim() || key.length > 240) return fail(400, "IDEMPOTENCY_KEY_REQUIRED");
    if (parts[0] === "inventories" && parts.length === 1) return { status: 200, body: repo.recordInventory(input.body, key) };
    if (parts[0] !== "campaigns") return fail(404, "UNSUPPORTED_OPERATION");
    if (parts.length === 1) return { status: 200, body: repo.prepare(input.body, key) };
    const [, id, action, mutationId, mutationAction] = parts;
    if (!id) return fail(404, "UNSUPPORTED_OPERATION");
    if (parts.length === 3 && action === "native-draft") { emptyBody.parse(input.body ?? {}); return { status: 200, body: await repo.createDraft(id, key) }; }
    if (parts.length === 3 && action === "decisions") return { status: 200, body: repo.decide(id, decisionBody.parse(input.body).decisionRef, key) };
    if (parts.length === 3 && action === "publish") { emptyBody.parse(input.body ?? {}); return { status: 200, body: await repo.publish(id, key) }; }
    if (parts.length === 3 && action === "mutations") return { status: 200, body: repo.proposeMutation(id, input.body, key) };
    if (parts.length === 5 && action === "mutations" && mutationId && mutationAction === "apply")
      return { status: 200, body: await repo.applyMutation(id, mutationId, mutationAuthorizationSchema.parse(input.body), key) };
    return fail(404, "UNSUPPORTED_OPERATION");
  } catch (error) {
    if (error instanceof z.ZodError) return fail(422, "INVALID_MEDIA_REQUEST");
    if (error instanceof AgentConflict) return fail(409, error.message);
    if (error instanceof MediaSourceUnavailable) return fail(503, error.message);
    throw error;
  }
}
