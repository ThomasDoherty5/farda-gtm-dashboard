import { z } from "zod";
import { AgentConflict } from "./store.ts";
import { PortfolioAuthorityUnavailable, type PortfolioRepository } from "./portfolioStore.ts";

export type PortfolioRouteInput = { method: string; path: string; body?: unknown; role: "reader" | "reviewer"; idempotencyKey?: string };
/** Called only after the existing server's scope authentication, body limit and CSRF checks. */
export async function handlePortfolioRoute(input: PortfolioRouteInput, repository: PortfolioRepository): Promise<{ status: number; body: unknown } | null> {
  if (!input.path.startsWith("/v1/portfolio/")) return null;
  try {
    const match = /^\/v1\/portfolio\/reviews\/([a-f0-9]{64})(?:\/(history|decisions|participation))?$/.exec(input.path);
    if (input.method === "GET" && match && (!match[2] || match[2] === "history")) {
      const latest = repository.latest(match[1]!);
      if (!latest) return { status: 404, body: { code: "REVIEW_NOT_FOUND" } };
      return { status: 200, body: match[2] === "history" ? repository.history(match[1]!) : latest };
    }
    if (input.method !== "POST" || !(input.path === "/v1/portfolio/reviews" || match && ["decisions", "participation"].includes(match[2] ?? ""))) return { status: 404, body: { code: "UNSUPPORTED_OPERATION", executionCertainty: "notApplied" } };
    if (input.role !== "reviewer") return { status: 403, body: { code: "REVIEWER_REQUIRED", executionCertainty: "notApplied" } };
    if (!input.idempotencyKey?.trim() || input.idempotencyKey.length > 240) return { status: 400, body: { code: "IDEMPOTENCY_KEY_REQUIRED", executionCertainty: "notApplied" } };
    if (input.path === "/v1/portfolio/reviews") return { status: 200, body: await repository.review(input.body, input.idempotencyKey) };
    if (match?.[2] === "decisions") return { status: 200, body: await repository.decide(match[1]!, input.body, input.idempotencyKey) };
    return { status: 200, body: await repository.recordParticipation(match![1]!, input.body, input.idempotencyKey) };
  } catch (error) {
    if (error instanceof z.ZodError) return { status: 400, body: { code: "INVALID_INPUT", executionCertainty: "notApplied" } };
    if (error instanceof AgentConflict) return { status: 409, body: { code: error.message, executionCertainty: "notApplied" } };
    if (error instanceof PortfolioAuthorityUnavailable) return { status: 503, body: { code: error.message, executionCertainty: "notApplied" } };
    throw error;
  }
}
