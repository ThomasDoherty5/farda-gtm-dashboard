import { z } from "zod";
import { AssetRepository, AssetError, assetSearchSchema } from "./assetStore.ts";

export type AssetRouteRequest = {
  method: string; path: string; body?: unknown; role: "reader" | "reviewer"; idempotencyKey?: string;
};
export type AssetRouteResponse = { status: number; body: unknown };

/** Mount only after the service's session/bearer authentication and cookie CSRF checks. */
export async function handleAssetRoute(request: AssetRouteRequest, repository: AssetRepository): Promise<AssetRouteResponse | null> {
  const url = new URL(request.path, "http://localhost");
  const path = url.pathname;
  if (path !== "/v1/assets" && !path.startsWith("/v1/assets/")) return null;
  try {
    const ok = (body: unknown): AssetRouteResponse => ({ status: 200, body });
    if (request.method === "GET" && path === "/v1/assets") {
      const query = Object.fromEntries(url.searchParams);
      return ok(await repository.search({ ...query,
        ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}),
        ...(query.offset !== undefined ? { offset: Number(query.offset) } : {}),
      }));
    }
    if (request.method === "GET") {
      const match = /^\/v1\/assets\/([^/]+)$/.exec(path);
      if (match) {
        const id = decodeURIComponent(match[1]!);
        const version = url.searchParams.has("version") ? Number(url.searchParams.get("version")) : undefined;
        const asset = repository.get(id, version);
        if (!asset) throw new AssetError("ASSET_NOT_FOUND", 404);
        return ok({ asset, exports: repository.exports(id), deployments: repository.deployments(id), deploymentObservations: repository.deploymentObservations(id), withdrawals: repository.withdrawals(id) });
      }
    }
    if (request.method !== "POST") throw new AssetError("UNSUPPORTED_ASSET_OPERATION", 404);
    if (path === "/v1/assets/eligibility") return ok(await repository.eligibility(request.body));
    if (request.role !== "reviewer") throw new AssetError("REVIEWER_REQUIRED", 403);
    const key = request.idempotencyKey;
    if (!key || !key.trim() || key.length > 240) throw new AssetError("IDEMPOTENCY_KEY_REQUIRED", 400);
    if (path === "/v1/assets/ingest") return ok(await repository.ingest(request.body, key));
    if (path === "/v1/assets/exports") return ok(await repository.prepareExport(request.body, key));
    if (path === "/v1/assets/deployments/observe") return ok(await repository.observeDeployment(request.body, key));
    if (path === "/v1/assets/rights/reconcile") return ok(await repository.reconcileRights(request.body, key));
    const withdrawal = /^\/v1\/assets\/withdrawals\/([^/]+)\/reconcile$/.exec(path);
    if (withdrawal) return ok(await repository.reconcileWithdrawal(decodeURIComponent(withdrawal[1]!), request.body, key));
    throw new AssetError("UNSUPPORTED_ASSET_OPERATION", 404);
  } catch (error) {
    if (error instanceof AssetError) return { status: error.status, body: { code: error.code, reasonCodes: error.reasons, executionCertainty: "notApplied" } };
    if (error instanceof z.ZodError || error instanceof URIError) return { status: 400, body: { code: "INVALID_ASSET_INPUT", executionCertainty: "notApplied" } };
    // Never return an adapter's private source payload, stack or file location.
    return { status: 500, body: { code: "ASSET_OPERATION_FAILED", executionCertainty: "uncertain" } };
  }
}

export { assetSearchSchema };
