import type { ActionRequest, ActionResponse, Environment, ReadRequest, ReadResponse } from "./contract";

export type ReadOptions = { signal?: AbortSignal };

/** The only seam screens use to reach data. No route may call a provider API directly. */
export interface FardaAdapter {
  readonly environment: Environment;
  readonly kind: "demo" | "live";
  readView<F, T>(request: ReadRequest<F>, options?: ReadOptions): Promise<ReadResponse<T>>;
  submitAction<P>(request: ActionRequest<P>, options?: ReadOptions): Promise<ActionResponse>;
}
