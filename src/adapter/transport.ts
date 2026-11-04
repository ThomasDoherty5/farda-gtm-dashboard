import type { ActionRequest, ReadRequest, SaveResourceRequest } from "./contract";

/**
 * The seam between the live adapter and whatever carries requests to the backend (THO-283).
 *
 * The host supplies the transport. It owns the URL, the session and any credentials, so none of them exist in this code,
 * in browser storage or in a request envelope. This file proposes no backend URL, path, header or sign-in flow.
 */
export type TransportRequest =
  | { kind: "read"; envelope: ReadRequest<unknown> }
  | { kind: "action"; envelope: ActionRequest<unknown> }
  | { kind: "save"; envelope: SaveResourceRequest<unknown> };

export type TransportOptions = { signal: AbortSignal };

export interface Transport {
  /** Resolves the raw JSON body of a successful answer, unparsed by the contract. Rejects with a `TransportFailure` otherwise. */
  send(request: TransportRequest, options: TransportOptions): Promise<unknown>;
}

export type TransportFailureKind =
  /** An answer arrived with a non-success status. `status` and, when the body was JSON, `body` are set. */
  | "http"
  /** No answer: the connection failed or dropped. */
  | "network"
  /** The transport gave up waiting. */
  | "timeout"
  /** The request was cancelled before an answer. */
  | "aborted"
  /** No transport has been published, so nothing was sent. */
  | "notConfigured";

export class TransportFailure extends Error {
  readonly kind: TransportFailureKind;
  readonly status: number | null;
  /** The parsed JSON error body, if the answer had one. Never a raw response, so it holds no headers or cookies. */
  readonly body: unknown;
  readonly retryAfterMs: number | null;
  /**
   * `false` only when the transport knows it never put the request on the wire (a refused connection, for example).
   * Anything else is treated as "the server may have acted".
   */
  readonly requestSent: boolean;

  constructor(
    kind: TransportFailureKind,
    init: { status?: number | null; body?: unknown; retryAfterMs?: number | null; requestSent?: boolean; message?: string } = {},
  ) {
    super(init.message ?? kind);
    this.name = "TransportFailure";
    this.kind = kind;
    this.status = init.status ?? null;
    this.body = init.body;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.requestSent = init.requestSent ?? kind !== "notConfigured";
  }
}

/** The default until a transport is published: nothing is sent and every call says so. */
export const pendingTransport: Transport = {
  send: () => Promise.reject(new TransportFailure("notConfigured", { requestSent: false })),
};
