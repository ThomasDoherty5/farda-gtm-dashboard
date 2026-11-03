import type { FardaAdapter, ReadOptions } from "./adapter";
import type { Environment, ReadRequest, ReadResponse } from "./contract";
import { AdapterError } from "./errors";

/**
 * Live adapter placeholder. The authenticated backend boundary (THO-283) is not deployed,
 * so every read fails with INTEGRATION_PENDING. It never falls back to demo data.
 * When wired: same-origin cookie session only; no provider credentials or tokens in the client.
 */
export function createLiveAdapter(environment: Exclude<Environment, "demo">): FardaAdapter {
  return {
    environment,
    kind: "live",
    async readView<F, T>(request: ReadRequest<F>, _options?: ReadOptions): Promise<ReadResponse<T>> {
      throw new AdapterError({
        code: "INTEGRATION_PENDING",
        message: "The live data service is not connected yet.",
        requestId: request.requestId,
        correlationId: null,
        retryable: false,
        retryAfterMs: null,
      });
    },
  };
}
