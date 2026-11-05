# Creator operations extension

This extension reuses the authenticated creator-agent server and its scoped SQLite connection. It adds a Shipping Hub frontend, portfolio review records, and an asset registry. It does not install or enable Zaps, buy shipping labels, publish content, send invitations, or release advertising funds.

## Shipping Hub

Open `/operations?view=hub`. The demo uses synthetic fixtures through `useView("shippingHub")`; live mode never falls back to them. The current server returns `INTEGRATION_PENDING` for this view until the shipping source adapter is connected. The existing operations and shipping routes remain available.

A label, carrier acceptance, and delivery are separate facts. Customer orders, creator allocations, replacements and rewards retain their originating identity. Bulk label review binds the selected row versions and approved address, reservation, parcel and rate evidence; it is a draft, not a purchased label. No purchase endpoint is invented by the frontend.

## Authenticated API

The existing server tokens, session roles, same-origin cookie CSRF checks, JSON body limit and no-store responses apply. Every write requires the reviewer role and a stable `Idempotency-Key`. Domain writes bind the configured workspace/account scope. All source authority implementations stay server-side. Neither arbitrary source URLs nor caller-provided approval flags confer authority.

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/portfolio/reviews` | Append a weekly review or an explicitly authorized on-demand review |
| `GET /v1/portfolio/reviews/:key` | Read the latest stored review |
| `GET /v1/portfolio/reviews/:key/history` | Read review, decision and repeat-participation history |
| `POST /v1/portfolio/reviews/:key/decisions` | Resolve an exact founder decision from Linear through the trusted authority |
| `POST /v1/portfolio/reviews/:key/participation` | Record bounded repeat-participation evidence |
| `GET /v1/assets` | Search a bounded page of scoped asset metadata |
| `GET /v1/assets/:id` | Read an asset and its export/deployment/withdrawal history |
| `POST /v1/assets/ingest` | Resolve an authorized opaque source reference and append an asset version |
| `POST /v1/assets/eligibility` | Check current exact-version and inherited rights; reader role is allowed |
| `POST /v1/assets/exports` | Prepare a reuse handoff; never publish or download a file |
| `POST /v1/assets/deployments/observe` | Persist a deployment receipt verified by its source authority |
| `POST /v1/assets/rights/reconcile` | Recheck reuse and prepare withdrawal intents for the owning executor |
| `POST /v1/assets/withdrawals/:id/reconcile` | Record a verified source outcome without performing a withdrawal |

Request schemas and versioned output types are defined in `portfolio.ts`, `portfolioStore.ts`, `assets.ts` and `assetStore.ts`. A repeated key with the same request returns its original receipt. Reusing a key with changed content is a conflict; version conflicts require rereading and a new reviewed proposal.

## Existing orchestration handoff

Reuse the existing weekly performance-review trigger and source event IDs. Send one reviewed, scoped portfolio packet to the service. Keep the source event ID stable across retries; do not add a second schedule. Store the returned review key, revision and hash with the Linear decision request. A Slack interaction is not execution authority until the exact founder decision is verified in Linear. Approved proposals return handoffs for the existing commercial/approval/contact/sample workflows rather than calling a provider directly.

Content submission events pass opaque source references to asset ingestion. The injected source authority resolves authorized objects, reports quarantine/unavailability and checks version/checksum identity. The existing content-review service remains the rights authority. A server-owned destination resolver binds the actual channel, territory and use kind to the scoped destination; callers cannot relabel an ad placement to fit a license. Each downstream reuse executor must recheck current eligibility and its own publishing permission immediately before an external action; an old prepared export or replayed receipt is not a fresh license.

A rights-change event uses bounded pages (`cursor`, `limit`) to enumerate affected reuse and records bounded withdrawal intents. The owning content/ad executor handles approved withdrawal and returns a verifiable receipt. Continue with the returned opaque cursor until `scanFinished` is true, retaining a distinct stable idempotency key for each page; a zero-impact page does not mean the scan is complete. The cursor binds the asset and an append-only export watermark. An uncertain receipt stays uncertain. Deployment identity is stable across observations. Verified source versions determine current state; late observations cannot resurrect a removed deployment, and observation receipts remain append-only. Creator public-post facts are retained even when paid reuse is not permitted.

## Deployment boundary

The default launcher injects no live portfolio decision or asset source/rights authorities. Capabilities therefore report `notConnected`; an injected implementation is reported as `injected`, not as production-verified. No new paid service is required by these modules. Hosting, Zapier trigger mapping, provider credentials and authorized source adapters remain the existing deployment/runtime owners' work. Configure and verify them before enabling live workflows.

Validation includes deterministic rules, scoped SQLite restart/replay, authenticated HTTP/CSRF tests, frontend adapter tests and browser accessibility/journeys. Synthetic authorities are test fixtures only and must never be supplied to a live deployment.
