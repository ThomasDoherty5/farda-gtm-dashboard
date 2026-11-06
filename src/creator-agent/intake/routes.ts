import { z } from "zod";
import { AgentConflict } from "../store.ts";
import { RECRUITMENT_SOURCES, opaqueRef } from "./contract.ts";
import { IntakeRepository, IntakeSourceUnavailable } from "./repository.ts";

const source = z.enum(RECRUITMENT_SOURCES);
type Input = { method: string; path: string; role: "reviewer" | "reader"; body?: unknown; idempotencyKey?: string };

/**
 * POST /v1/intake (reviewer) records one J01 event. GET /v1/intake/events/:source/:eventId, /v1/intake/creators/:creatorId and
 * /v1/intake/sources/:source/:accountId read it back. No route sends, invites, scores or reserves anything.
 */
export async function handleIntakeRoute(input: Input, repo: IntakeRepository) {
  const url = new URL(input.path, "http://localhost");
  if (url.pathname !== "/v1/intake" && !url.pathname.startsWith("/v1/intake/")) return null;
  const fail = (status: number, code: string) => ({ status, body: { code, executionCertainty: "notApplied" } });
  try {
    if (input.method === "GET") {
      const [, , , kind, a, b, ...rest] = url.pathname.split("/");
      if (rest.length || [...url.searchParams.keys()].length) return fail(400, "INVALID_INTAKE_QUERY");
      const record = kind === "events" && a && b ? repo.event(source.parse(a), opaqueRef.parse(decodeURIComponent(b)))
        : kind === "creators" && a && !b ? repo.creator(decodeURIComponent(a))
        : kind === "sources" && a && b ? repo.sourceStatus(source.parse(a), opaqueRef.parse(decodeURIComponent(b)))
        : undefined;
      if (record === undefined) return fail(404, "UNSUPPORTED_OPERATION");
      return record ? { status: 200, body: record } : fail(404, "INTAKE_RECORD_UNAVAILABLE");
    }
    if (input.method !== "POST" || url.pathname !== "/v1/intake") return fail(405, "UNSUPPORTED_METHOD");
    if (input.role !== "reviewer") return fail(403, "REVIEWER_REQUIRED");
    const key = input.idempotencyKey;
    if (!key?.trim() || key.length > 240) return fail(400, "IDEMPOTENCY_KEY_REQUIRED");
    return { status: 200, body: await repo.ingest(input.body, key) };
  } catch (error) {
    if (error instanceof z.ZodError) return fail(422, "INVALID_INTAKE");
    if (error instanceof AgentConflict) return fail(409, error.message);
    if (error instanceof IntakeSourceUnavailable) return fail(503, error.message);
    throw error;
  }
}
