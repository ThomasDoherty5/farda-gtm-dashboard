# Paid-media campaign drafts and guarded execution — THO-346

This server-only module drafts Meta and TikTok campaigns from an immutable manifest. It publishes or changes one only after an exact J04 Linear decision and all five media gates. It reuses native purchase-optimized delivery and never bids in an auction. THO-191 remains the performance importer.

It uses the scoped agent SQLite handle and creates only `media_*` tables. Construct `PaidMediaRepository(db, scope, authority, now?)`. Every source is injected by trusted server configuration through `mediaAuthority`, never by a caller. The sources are the account, per-operation capability observations, checkout, offer version, creative assets and rights, the five gate receipts, the J04 decision and the provider executor. None is connected yet. The tests use synthetic sources only. No test touches a real advertiser account, shop or campaign, and nothing spends money.

## Flow

1. **Inventory** (`POST /v1/media/inventories`, read with `GET /v1/media/inventories/:provider/:accountRef`). This records the account's kind, market, currency, timezone and approved identity. It also records every operation (read reports, upload creative, preview creative, create draft, publish, edit budget, pause, retrieve outcome) on every route (`api`, `mcp`, `browser`).
   - Each entry is Ready, Unverified, Unsupported or Denied. It keeps its source, tool version, test receipt, receipt origin and expiry.
   - Ready needs an in-date `account-test` observation with a receipt. MCP discovery or documentation stays Unverified, so tool discovery is never account authorization.
   - An unknown market, timezone or currency stays null and holds the campaign. A wrong account is never shown.
2. **Prepare** (`POST /v1/media/campaigns`). The route follows the actual checkout:
   - Meta website checkout with verified purchase events: `meta-sales-purchase`.
   - TikTok Shop with verified Shop authorization: `tiktok-gmv-max-product`.
   - Website with verified purchase events: `tiktok-smart-plus-web-sales`.
   - Any other combination holds the campaign with the reason.
   - The manifest covers the account, checkout, SKU, offer and claims version, and the creative and rights hashes and expiry. It also covers the destination, objective and event, attribution, schedule, currency, targeting, bid or ROI parameters and caps. Extra delivery budget, Max Delivery, auto-recharge and placement expansion are always false.
   - The manifest is written once per revision and hashed. Any change to the asset, offer, rights, caps or other inputs makes a new revision and clears approval. The production environment is always held.
3. **Native draft** (`/:id/native-draft`). The executor creates or updates the native campaign as `PAUSED` under the key `draft:<id>:r<revision>`. Native IDs, ad IDs and the preview are stored. The native settings are then read back and compared with the manifest field by field, including the extras and placement scope. Only a matching read-back requests release (`releaseRequested`, `releaseHash`). A mismatch holds the campaign with `READBACK_MISMATCH:<FIELD>`. Drafting never publishes or activates spend.
4. **Decide** (`/:id/decisions`). The J04 receipt must come from Linear. A Slack or Notion decision is refused. It must match the scope, campaign, revision, manifest hash and release hash, be current and in date, and be made after release was requested. Its financial scope must cover the account, route, placements, daily cap and lifetime cap.
5. **Publish** (`/:id/publish`). These checks run again at dispatch:
   - The native draft is read again, so a draft edited outside Farda is refused.
   - Every source is re-resolved, so changed assets or offers and expired rights are refused.
   - The decision and its financial scope must still hold.
   - All five gates need a verified, unexpired receipt for this manifest: qualified product and released stock; reviewed content with paid rights or native permission; a functioning actual-offer checkout; tested attribution, dedup and refunds; and the fulfillment, support and cash bridge. Gate results are shown even when they refuse.
   - The publish capability must be executable.

   - The request must not have expired and the scheduled start must not have passed (`REQUEST_EXPIRED`, `SCHEDULE_START_PASSED`).

   Before every publish write, first attempt or retry, the native draft is read again and compared in full with the manifest and the approved read-back: caps, extras, placements, identity, ads and preview. Any difference holds the campaign and nothing is sent.

   The state is then committed as `applying` under a two-minute lease, with the key `publish:<id>:r<revision>` and a lease token. A concurrent call gets `EXECUTION_IN_PROGRESS`. An error or unreadable receipt leaves the campaign `uncertain`. A repeated publish of a confirmed campaign returns the same result.

   Reconciliation never needs a current decision. The next call reads the provider by the original key, then by the native campaign. If the provider shows it live or rejected, that is recorded. If nothing happened, the write is re-sent with the same key only when the draft is unchanged and every release check, including a current decision, still holds. Otherwise the pending write is closed: a lapsed or changed decision returns the campaign to `draft` with release still requested and `NEW_DECISION_REQUIRED`; a changed draft holds it.

   Only the worker holding the current lease token may finish or release a write. A late result from a worker whose lease expired leaves the record unchanged. A second worker that takes over an expired lease reads back by key and native campaign before re-sending. It relies on the provider treating the key idempotently, so a write the first worker sends late is not applied twice.
6. **Mutations** (`/:id/mutations`, then `/:id/mutations/:mutationId/apply` with `{decisionRef}` or, for a pause, `{policyRef}`). A repeated event returns the same open mutation. The native state is recorded before and after with the provider receipt.
   - A budget edit needs a released campaign and its own J04 decision for that exact edit, within the approved financial scope. A retry rechecks the decision and scope.
   - **Safety pause.** A pause is applied whenever the native campaign reads active, including a draft the provider activated on its own. It needs either its own J04 decision or a current, in-date safety policy (THO-347) from the trusted `safetyPolicy` resolver that allows pausing that account. A policy can only pause; it never raises or changes spend. A pause never needs a budget and is never blocked by another mutation's pending write.
   - An uncertain mutation is reconciled by its key, then by the native campaign. If nothing happened and it cannot be re-sent now, it is closed as `not-applied` with the reason and its lock is released.

Reads: `GET /v1/media/campaigns/:id` and `GET /v1/media/campaigns/:id/mutations/:mutationId`.

Every POST needs an `Idempotency-Key`. The key is bound to exactly one command, such as the publish of one campaign or the apply of one mutation. Reusing it for anything else is refused with `IDEMPOTENCY_KEY_REUSED`.

## Browser routes

A Denied API or MCP capability is never bypassed in a browser. A browser route is used only when both programmatic routes are Unsupported and the browser capability for that exact operation is itself Ready. An Unverified programmatic route does not fall through either. If the browser executor reports MFA, a CAPTCHA or UI drift, the action is held for a person with `BROWSER_HANDOFF_<REASON>`. The pending write is then confirmed only from the source read-back.

## What the view shows

- `state`: `held`, `draft`, `approved`, `rejected` (Farda), `applying`, `confirmed`, `provider-rejected` or `uncertain`. Provider review (`providerReview`) is kept apart from Farda approval (`approval`).
- `sourceEffects`: `none`, `draft-created` or `publish-attempted`. Mutations report `mutation-attempted`. Mutation states add `not-applied` for a write that reconciliation found was never applied.
- `receipts` and `evidenceLabel`: each provider receipt carries `receiptOrigin` (`synthetic` or `account`). The label is `synthetic`, `account-backed` or `mixed`, so account-backed read and draft receipts are never confused with fixtures.
- Money is integer USD minor units. Unknown values stay null.

## Not done here

This module does not include real Meta or TikTok MCP or API connections, account-backed capability receipts, J04 receipt resolution (THO-321), gate and safety-policy resolvers (THO-347) or a frontend view of these states.
