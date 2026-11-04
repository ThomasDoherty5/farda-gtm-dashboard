# Live adapter: the front-end half

`src/adapter/liveAdapter.ts` implements `FardaAdapter` over an injected `Transport` (`src/adapter/transport.ts`). **Stage: fixture-complete, front-end half only.** No backend exists to talk to. Nothing here is integration-verified or production-authorized, and the tests prove the front end against test doubles, not against a service.

The adapter proposes no backend URL, path, header or sign-in flow. The only configuration is the reserved `VITE_FARDA_ADAPTER_BASE_URL`, which `selectAdapter` passes untouched to a host-supplied transport factory. With no factory the default transport sends nothing and every call answers `INTEGRATION_PENDING`, so nothing changes on screen until a real transport is plugged in.

## The seam

```ts
interface Transport {
  send(request: { kind: "read" | "action" | "save"; envelope: <typed request> }, options: { signal: AbortSignal }): Promise<unknown>;
}
```

The transport resolves the raw JSON body of a successful answer or rejects with a `TransportFailure` (`kind`: `http`, `network`, `timeout`, `aborted`, `notConfigured`; plus `status`, parsed JSON `body`, `retryAfterMs`, and `requestSent`). The host builds it. It owns the address, the session cookie or token, and any signing. The adapter sees none of them.

## What the adapter does

| Concern | Behavior | Tested in |
| -- | -- | -- |
| Shape | Reads, actions and saves are parsed with the contract's zod schemas (`wire.ts` adds the save response and the error body). A bad shape never reaches a screen. Unknown envelope fields are dropped, not rejected (see T-05). | `liveAdapter.test.ts` |
| Scope | The response scope must equal the requested scope (workspace, environment, accounts as a set), for reads, actions and saves. A request for another environment is refused before anything is sent. | `liveAdapter.test.ts`, conformance `SCOPE-*` |
| 401, expired session | `UNAUTHENTICATED` or `SESSION_EXPIRED`, never retryable. `useView` and `useAction` drop protected data. The status wins over a body claiming another code. | `liveAdapter.test.ts`, conformance `AUTH-*` |
| 403 | `FORBIDDEN` or `SOURCE_AUTHORITY_DENIED`, never retryable, with a fixed neutral message that says nothing about what exists. | same |
| Network loss, 5xx, unavailable | `SOURCE_UNAVAILABLE`, retryable. No data, no demo fallback. | same, conformance `PENDING-*` |
| Timeout | An attempt is bounded by `timeoutMs` even if the transport ignores its abort signal. `TIMEOUT`, retryable. | `liveAdapter.test.ts` |
| Abort by the caller | Rejects with the abort itself, not an `AdapterError` and not an answer. It reaches the transport and stops a pending retry. | same |
| Write outcome | A write that may have reached the server and got no definite answer (network loss, timeout, 5xx, unreadable body) carries `executionCertainty: "uncertain"`. A refusal (401, 403, 404, 422, 429) or a refused connection carries `notApplied`. | same |
| Retry | A write is attempted up to `writeAttempts` (default 2) times on network loss, timeout or 5xx. Every attempt carries the same `idempotencyKey` and `requestId`. A definite refusal is not retried. Reads are not retried by the adapter. | same |
| `STALE_VERSION` | A typed 409 body keeps its code and `currentVersion`. It is a recoverable conflict (`conflict` category, `notApplied`, not retryable). An untyped conflict is `VALIDATION_FAILED`, not a guessed conflict. | same, conformance `VER-*` |
| Approved is not Sent | An action answer of `succeeded` or `partiallySucceeded` with no `receiptRefs`, or with `executionCertainty: notApplied`, is refused as `OUTCOME_UNCERTAIN`. `approved` (Q-01) is never read as a send. `controlRun` and `reconcileRun` without a top-level `runRef` are refused before anything is sent (Q-03). A preview, approval request or decision can never answer as sent or running, even with a receipt. | same, conformance `SENT-*` |
| Unreadable write answer | `OUTCOME_UNCERTAIN` with `uncertain`. Never success. | same |
| Credentials | Source scan test: the adapter files use no storage, cookie, `fetch`, credential header or URL. Text the server sends is stripped of credential-shaped strings (`redact`) and the server's text is replaced by a fixed message for 401 and 403. | `liveAdapter.test.ts` |

## What only the server can do

The adapter cannot make these true. They stay with the backend owner. See the table in the pull request description.

- Authenticate, derive the actor, workspace, role and allowed accounts, and refuse the wrong ones (AD-01).
- Enforce one dispatch per idempotency key, including concurrent requests, and replay the original receipt (AD-05). The adapter sends the same key on retry and the tests use a double that replays; they do not prove a real server does.
- Check approval, terms version, workflow phase, budget, stock, quota and lease at dispatch (AD-04, AD-07).
- Report real freshness, coverage and provenance (AD-03). The adapter validates the shape and passes unknown and N/A through unchanged. It cannot know that a counter is really private or stale.
- Keep provider credentials, logs and error text free of secrets (AD-02). The adapter redacts what it displays. It cannot clean a server log.

## How to plug the transport in

1. Write a `Transport` in the host that adds the session and sends the envelope to the published endpoint.
2. Pass it in: `selectAdapter(import.meta.env, location.search, { createTransport: ({ environment, baseUrl }) => myTransport })`.
3. Map failures: reject with `TransportFailure("http", { status, body })` where `body` is the parsed JSON error body, `network`, `timeout`, or `aborted`. Set `requestSent: false` only when it is certain nothing went on the wire.
4. Add a target to `src/adapter/conformance.test.ts` over the sandbox. Delete nothing from the existing targets.

## Proposals for the freeze

Same headings as the freeze register (`docs/adapter-freeze-register.md` in PR #46). IDs are `T-nn` so they do not collide with its `Q-nn`. All are **proposed**.

### Error codes

No new code is introduced. The adapter uses only codes already in `errors.ts`: `UNAUTHENTICATED`, `SESSION_EXPIRED`, `FORBIDDEN`, `SOURCE_AUTHORITY_DENIED`, `RECORD_NOT_FOUND`, `STALE_VERSION`, `RATE_LIMITED`, `SOURCE_UNAVAILABLE`, `TIMEOUT`, `OUTCOME_UNCERTAIN`, `INTEGRATION_PENDING`, `VALIDATION_FAILED`.

| Situation | Code the adapter raises |
| -- | -- |
| A read answer that is not the contract's shape | `SOURCE_UNAVAILABLE`, not retryable |
| A write answer that is not the contract's shape, a scope mismatch on a write, success without a receipt, an approval answered as sent | `OUTCOME_UNCERTAIN` or `FORBIDDEN` with `executionCertainty: uncertain` |
| A read answer for another scope | `FORBIDDEN` (as `useView` already does) |
| An untyped 4xx other than 401, 403, 404, 429 | `VALIDATION_FAILED`, `notApplied` |

### Open questions and proposals

| ID | Question or proposal | Used in | Status |
| -- | -- | -- | -- |
| T-01 | The error body on the wire is `AdapterErrorBody` (`code`, `message`, `requestId`, `correlationId`, `retryable`, `retryAfterMs`, `fieldErrors?`, `currentVersion?`, `executionCertainty?`), as JSON, with the HTTP status or equivalent. Today it exists only in `errors.ts`; `wire.ts` holds its zod mirror. Freeze it in the contract. | `wire.ts`, `liveAdapter.ts` | proposed |
| T-02 | `SaveResourceResponse` has no zod schema in `contract.ts`. `wire.ts` holds a mirror. Move it into the contract at the freeze. | `wire.ts` | proposed |
| T-03 | A replay of an idempotency key returns the first answer, **including its original `requestId`**. The adapter therefore does not require a write's `requestId` to equal the request's, while it does for reads. The freeze should say whether a replay keeps the original `requestId` (as the demo does) or echoes the new one, so the adapter can check it. | `liveAdapter.ts`, conformance `IDEM-2` | proposed |
| T-04 | `executionCertainty` rule on the wire: a server that rejects before any effect says `notApplied`. When it says nothing, the adapter assumes `uncertain` for any write that may have reached it, and `notApplied` for 401, 403, 404, 422, 429. Confirm or replace. | `liveAdapter.ts` | proposed |
| T-05 | The contract schemas strip unknown fields. The adapter returns the stripped envelope, so an extra field never reaches a screen, but a backend that adds fields is not told. Decide whether the contract becomes strict (conformance `SCHEMA-3`). | `liveAdapter.ts`, `conformance.ts` | proposed |
| T-06 | Which operations may answer `succeeded` or `partiallySucceeded`: the adapter allows it only with a receipt, and never for `previewAction`, `requestApproval` or `decideApproval`. `running` is also refused for those three. Confirm against the approval contract (THO-277). | `liveAdapter.ts` | proposed |
| T-07 | A 429 should carry `retryAfterMs` in the body or the transport failure. The adapter passes it through and does not retry a 429 itself. | `liveAdapter.ts` | proposed |
| T-08 | Timeout default is 30 seconds per attempt and two attempts for writes. These are front-end defaults, not a service agreement. | `liveAdapter.ts` | proposed |
