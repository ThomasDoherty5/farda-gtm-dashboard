import type { ActionRequest, ActionResponse, Environment, ReadRequest, ReadResponse, SaveResourceRequest, SaveResourceResponse } from "./contract";

export type ReadOptions = { signal?: AbortSignal };

/** The only seam screens use to reach data. No route may call a provider API directly. */
export interface FardaAdapter {
  readonly environment: Environment;
  readonly kind: "demo" | "live";
  readView<F, T>(request: ReadRequest<F>, options?: ReadOptions): Promise<ReadResponse<T>>;
  submitAction<P>(request: ActionRequest<P>, options?: ReadOptions): Promise<ActionResponse>;
  /** A versioned save that never dispatches a provider action. */
  saveResource<P, T>(request: SaveResourceRequest<P>, options?: ReadOptions): Promise<SaveResourceResponse<T>>;
}
