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

Portfolio authority adapters receive the expected workspace/account scope. A verified Linear decision must return that exact scope, review revision and scope-bound review hash. On-demand authorization returns a scoped receipt containing the exact approval reference, event ID and affirmative decision; a bare boolean is insufficient. Repeat-participation receipts must carry the same scope. Matching program/window keys in another account never transfer approval authority.

Content submission events pass opaque source references to asset ingestion. The injected source authority resolves authorized objects, reports quarantine/unavailability and checks version/checksum identity. The existing content-review service remains the rights authority. A server-owned destination resolver binds the actual channel, territory and use kind to the scoped destination; callers cannot relabel an ad placement to fit a license. Each downstream reuse executor must recheck current eligibility and its own publishing permission immediately before an external action; an old prepared export or replayed receipt is not a fresh license.

A rights-change event uses bounded pages (`cursor`, `limit`) to enumerate affected reuse and records bounded withdrawal intents. The owning content/ad executor handles approved withdrawal and returns a verifiable receipt. Continue with the returned opaque cursor until `scanFinished` is true, retaining a distinct stable idempotency key for each page; a zero-impact page does not mean the scan is complete. The cursor binds the asset and an append-only export watermark. An uncertain receipt stays uncertain. Deployment identity is stable across observations. Verified source versions determine current state; late observations cannot resurrect a removed deployment, and observation receipts remain append-only. Creator public-post facts are retained even when paid reuse is not permitted.

Verified withdrawal receipts include the native `attemptId` and a monotonic `sourceVersion` within that attempt. These values come from the trusted executor adapter, not the HTTP caller. An older receipt cannot clear a newer uncertain outcome, and a not-applied receipt from another attempt cannot clear an unresolved attempt. Conflicting outcomes for one attempt/version are rejected; nonconflicting historical receipts remain visible. A verified removal observation for an already bound deployment is preserved when the deleted destination can no longer be resolved, while new or active deployment observations still require current destination authority.

## Deployment boundary

The default launcher injects no live portfolio decision or asset source/rights authorities. Capabilities therefore report `notConnected`; an injected implementation is reported as `injected`, not as production-verified. No new paid service is required by these modules. Hosting, Zapier trigger mapping, provider credentials and authorized source adapters remain the existing deployment/runtime owners' work. Configure and verify them before enabling live workflows.

Validation includes deterministic rules, scoped SQLite restart/replay, authenticated HTTP/CSRF tests, frontend adapter tests and browser accessibility/journeys. Synthetic authorities are test fixtures only and must never be supplied to a live deployment.

## Source and dashboard integration

`GET /v1/assets/registry?registry=content|collaborations&limit=25` uses the configured Notion source reader under the existing reader authentication. Its continuation is opaque. Results report observed time, safe record references, completeness and source-link availability. An unconfigured or denied source returns a source-access error. A successful empty registry read has an empty records array and its observed coverage. Exact-version rights continue through J09.

The native launcher reads optional private configuration from `FARDA_ASSET_SOURCE_CONFIG`, containing `contentDataSourceId`, `collaborationDataSourceId` and optional `drive` binding with `accountId`, `permissionId` and `parentFolderIds`. Credentials come from `FARDA_NOTION_READ_TOKEN` and `FARDA_DRIVE_ACCESS_TOKEN`. The adapter verifies native Notion membership and relations, authenticated Drive identity, approved direct folder, binary revision/checksum and media metadata. It rechecks registry rows after the Drive read. The private reader key stabilizes redacted record references across restarts; a restarted source scan starts with a fresh cursor.

Optional `FARDA_PORTFOLIO_SOURCE_CONFIG` binds `organizationId`, `teamId`, `issueIds`, `founderUserIds`, optional `j04WriterBotIds`, `credentialKind` and `approvedLaunchAt`. `FARDA_LINEAR_READ_TOKEN` supplies the private credential. Trusted J18, J04 and participation resolvers are injected at server composition. The initial launcher holds verified weekly reviews and founder decisions until those independent resolvers are supplied. Sandbox history remains readable with its recorded provenance.

The authenticated `collaborationEvidence` read view accepts `{collaborationId}` and the standard page cursor/limit. It projects saved asset versions and exact linked portfolio review/decision/participation records. A source-bound, expiring cursor pins append-only table watermarks. Live J09 rights observations are evaluated for each returned asset page. The existing collaboration screen displays these records independently of the availability of the broader legacy collaboration source. Empty results mean no matching saved evidence in the scoped agent database.
