# Reference server

**A test double, not the backend.** It serves the demo services' fixture data over real HTTP so the live adapter and the HTTP transport can be exercised end to end. No identity provider, database, hosting or provider integration exists behind it, and THO-283 is not done because it exists. Stage: reference-server-verified at most; nothing here is integration-verified.

```
npm run reference-server           # 127.0.0.1:8787
REFERENCE_SERVER_PORT=8800 npm run reference-server
```

It binds only to 127.0.0.1, refuses to start when `NODE_ENV` is `production`, prints a banner saying what it is, and uses no new dependency (`node:http`; `run.mjs` loads the demo services through the repo's own Vite config). Everything in it is obviously fake and local; none of it is a secret.

## Use it with the app

```
npm run reference-server
VITE_FARDA_ADAPTER=sandbox VITE_FARDA_ADAPTER_BASE_URL=http://localhost:8787 npm run dev
```

Open `http://localhost:8787/dev/sign-in?user=founder&next=/` once. Use `localhost` for both the app and the server: the session cookie is `HttpOnly; SameSite=Lax` and host-based, so `127.0.0.1` for one and `localhost` for the other would not share it. The app's origin must be in `REFERENCE_SERVER_ORIGINS` (comma separated; default `http://localhost:5173,http://localhost:4173`).

## What it implements (docs/adapter-decisions.md)

| Decision | Behavior |
| -- | -- |
| Paths | `POST /v1/read`, `POST /v1/action`, `POST /v1/save`, `GET /v1/session`. |
| D-1 session | Fake sign-in at `GET\|POST /dev/sign-in?user=<role>` issues an `HttpOnly; SameSite=Lax` cookie (no `Secure`, because it is plain http on loopback). 12 hour lifetime, 60 minute sliding idle timeout. Writes need the `X-CSRF-Token` header from `GET /v1/session`. |
| D-2 | Only the current `schemaVersion` is accepted; anything else is `VALIDATION_FAILED` naming the supported ones. |
| D-3 | One fixed fake user per role: founder, operator, reviewer, finance, viewer, runner (`users.ts`). |
| D-4 | A workspace, account or environment outside the grant is `FORBIDDEN`. Never narrowed. |
| D-5 | Requester differs from approver; founder-only action kinds; only founder or reviewer decides; only founder, reviewer or the runner dispatches. Failure is `FORBIDDEN` with `AUTHORITY_REQUIRED` in the message. |
| D-8, D-9 | Keys are scoped to principal and kind and kept 14 days with the stored response. Same key and payload replays the stored answer. Same key and a changed payload is `MANIFEST_CHANGED`. |
| D-10 | Record versions leave the server as opaque `ver_…` tokens. An unknown token is passed on and answered as a stale version. |
| D-11 | `scenario` and `fixture` filters are `VALIDATION_FAILED`. (A dev sign-in may seed a named state with a demo fixture: `?state=<name>&fixture=<key>`.) |
| D-12 | Error categories map to 401, 403, 404, 409 (conflicts and holds), 422, 429, 503. An uncertain write is never a 2xx: it is `502 OUTCOME_UNCERTAIN` with `executionCertainty: uncertain`, stored under its key so a retry gets the same answer. |
| D-14 | Every error body has `code`, `message`, `requestId`, `correlationId`, `retryable`, `retryAfterMs`, `executionCertainty`. |
| D-15 | Per principal: 120 reads and 30 writes a minute, then `429 RATE_LIMITED` with `retryAfterMs` and `Retry-After`. |
| D-16 | In-memory, append-only audit log (frozen entries; names and statuses only, never payloads, cookies or tokens). `GET /dev/audit` shows it to a founder. |

## What it does not do

It is not a model of the backend's internals. Records live in the demo services' memory and reset when the server restarts. Sign-in names a user and checks nothing. The demo services underneath keep their own answers and have no 14 day retention, and their approval role is fixed to the reviewer, so a founder-required approval is refused by the demo even for a founder. The field filtering by role in D-3, the per-source limits in D-15, the Slack rules in D-6, exports in D-14 and the environment split in D-17 are not implemented.

## Tests

`npm test` runs `tools/reference-server/*.test.ts`: the conformance suite over `createLiveAdapter` + `createHttpTransport` against a server on an ephemeral port, and the negative tests (CSRF, cookie, role, scope, replay, changed payload, rate limit, uncertain outcome). `npm run test:e2e:reference` runs one browser journey. Neither `npm run verify` nor `npm run test:e2e` needs the server running.
