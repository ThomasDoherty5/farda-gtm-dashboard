import { z } from "zod";
import { AgentConflict } from "../store.ts";
import { MediaSourceUnavailable, MediaWriteUncertain } from "../media/repository.ts";
import { ref } from "./contract.ts";
import { MediaControlUncertain, MediaReleaseController } from "./repository.ts";

type Input = { method: string; path: string; role: "reviewer" | "reader"; body?: unknown; idempotencyKey?: string };
const decisionBody = z.object({ decisionRef: ref }).strict();
const emptyBody = z.object({}).strict();

/**
 * Staged media release routes (THO-347). Reads: GET /v1/media-control/stages/:ref, /v1/media-control/observations/:id and
 * /v1/media-control/changes/:id. Writes (reviewer, Idempotency-Key bound to one operation and target): POST /v1/media-control/stages,
 * /stages/:ref/decisions, /stages/:ref/release, /stages/:ref/observations, /stages/:ref/launches, /stages/:ref/changes,
 * /stages/:ref/safety, and /changes/:id/apply ({decisionRef} or, for a pause, {policyRef}).
 */
export async function handleMediaControlRoute(input: Input, controller: MediaReleaseController) {
  const url = new URL(input.path, "http://localhost");
  if (!url.pathname.startsWith("/v1/media-control/")) return null;
  const fail = (status: number, code: string, executionCertainty: "notApplied" | "uncertain" = "notApplied") => ({ status, body: { code, executionCertainty } });
  const parts = url.pathname.split("/").slice(3).map(decodeURIComponent);
  try {
    if ([...url.searchParams.keys()].length) return fail(400, "INVALID_MEDIA_CONTROL_QUERY");
    const [collection, id, action] = parts;
    if (input.method === "GET") {
      const record = parts.length !== 2 || !id ? undefined : collection === "stages" ? controller.read(id)
        : collection === "observations" ? controller.readObservation(id) : collection === "changes" ? controller.readChange(id) : undefined;
      if (record === undefined) return fail(404, "UNSUPPORTED_OPERATION");
      return record ? { status: 200, body: record } : fail(404, "MEDIA_CONTROL_RECORD_UNAVAILABLE");
    }
    if (input.method !== "POST") return fail(405, "UNSUPPORTED_METHOD");
    if (input.role !== "reviewer") return fail(403, "REVIEWER_REQUIRED");
    const key = input.idempotencyKey;
    if (!key?.trim() || key.length > 240) return fail(400, "IDEMPOTENCY_KEY_REQUIRED");
    if (collection === "stages" && parts.length === 1) return { status: 200, body: controller.proposeStage(input.body, key) };
    if (collection === "changes" && parts.length === 3 && id && action === "apply") return { status: 200, body: await controller.applyChange(id, input.body, key) };
    if (collection !== "stages" || parts.length !== 3 || !id) return fail(404, "UNSUPPORTED_OPERATION");
    if (action === "decisions") return { status: 200, body: controller.decideStage(id, decisionBody.parse(input.body).decisionRef, key) };
    if (action === "release") { emptyBody.parse(input.body ?? {}); return { status: 200, body: controller.releaseStage(id, key) }; }
    if (action === "observations") { emptyBody.parse(input.body ?? {}); return { status: 200, body: controller.observe(id, key) }; }
    if (action === "launches") return { status: 200, body: await controller.launch(id, input.body, key) };
    if (action === "changes") return { status: 200, body: controller.proposeChange(id, input.body, key) };
    if (action === "safety") return { status: 200, body: await controller.runSafety(id, input.body, key) };
    return fail(404, "UNSUPPORTED_OPERATION");
  } catch (error) {
    // A media write may have reached the provider: never report it as not applied.
    if (error instanceof MediaControlUncertain || error instanceof MediaWriteUncertain) return fail(409, error.message, "uncertain");
    if (error instanceof z.ZodError) return fail(422, "INVALID_MEDIA_CONTROL_REQUEST");
    if (error instanceof AgentConflict) return fail(409, error.message);
    if (error instanceof MediaSourceUnavailable) return fail(503, error.message);
    throw error;
  }
}
