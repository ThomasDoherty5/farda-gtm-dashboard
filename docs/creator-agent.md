# Creator agent runtime

This is the persistent reviewed-evidence agent, separate from the frontend demo and reference server. It evaluates structured, authenticated review packets; it does not autonomously watch media, obtain source permission, infer health traits, or contact creators.

## Start locally

Use Node 24 or later and `npm ci`. Configure these **server-only** variables outside the public repository:

- `FARDA_AGENT_READ_TOKEN` and `FARDA_AGENT_REVIEW_TOKEN`: different random values, at least 32 characters each. The reader cannot write.
- `FARDA_AGENT_WORKSPACE_ID` / `FARDA_AGENT_ACCOUNT_ID`: the exact authorized dashboard scope.
- Optional `FARDA_AGENT_DATABASE` (default `.agent-data/evidence.sqlite`), `FARDA_AGENT_HOST` (default `127.0.0.1`), `FARDA_AGENT_PORT` (overrides platform `PORT`, then defaults to8787), `FARDA_AGENT_CONFIG` (private binding file).
- Behind a same-origin TLS reverse proxy, set `FARDA_AGENT_ORIGIN` to the public origin and `FARDA_AGENT_SECURE_COOKIES=true`.

Run `npm run creator-agent`. It defaults to loopback. Explicit wildcard binding requires a configured HTTPS origin and secure cookies behind a trusted TLS proxy. SQLite and configuration records must live on a private durable volume with backups; do not commit them. Test sessions expire after an hour and are invalidated on restart. The [API-only hosting guide](creator-agent-hosting.md) covers the Node24 container, private volume, health probes, shutdown and verified online backups.

The service is not deployed by this script. Hosting, source permissions, authenticated production scope bootstrap, operational monitoring and a production release remain separate. A deployment must not expose a bare HTTP listener or place its machine tokens in the browser.

## Operations

- `GET /health`: service/schema identity only.
- `GET /v1/capabilities`: authenticated versions, storage schema and bound/unbound model hashes.
- `GET /v1/policy`: the agent-held versioned0–5 anchors, brief contexts, critical floors and buyer/viewer evidence rules.
- `PUT /v1/creators/:creatorId`: reviewer bearer credential, JSON content type and a unique `Idempotency-Key` header. Body: `{expectedVersion, policyVersion, configHash, packet}`. First expectedVersion is0. The policy revision is `2026-11-04`; the config hash must match capabilities (null while unbound).
- `GET /v1/creators/:creatorId`: reader/reviewer authentication; returns the persisted packet, run ID, revision, source hash and assessment. Changed runtime/configuration invalidates old readiness on read; old rows remain intact.
- `GET /v1/session`: reader Basic authentication (`reader:<read credential>`) can establish an HttpOnly/SameSite read session. Machine bearer credentials stay in the server/Zapier connection. No fake role-select sign-in is used.
- `POST /v1/read`: existing authenticated dashboard read envelope, with exact sandbox workspace/account scope. Supported read models are listed below. Unknown resources are404; no demo fallback. Other dashboard operations remain unsupported here.

The existing draft/mark-watched controls are held for projected records. Review packets are submitted through the authenticated review workflow; a frontend draft cannot manufacture a completed review or override a decision.

### Current sourcing and saved assessments

`discoverySummary` with filters `{}` returns `kind: "agent-sourcing"`: the actual latest saved assessment per creator and the current website/TikTok model bindings. It lists at most100 records and reports the actual total and partial coverage. This is a queue of saved reviews, not a claim of new discovery, provider capacity or an activated schedule.

`assessmentRecord` with filters `{creatorId, assessmentId}` uses the exact saved run ID as `assessmentId`. Its `kind: "creator-v3"` record contains the immutable original assessment/packet and the effective current readiness. A newer revision or changed runtime/configuration marks an old run stale/review-needed without replacing its saved decision or recalculating it in the browser. Superseded runs have no evidence-navigation shortcut that could silently open a newer packet.

`evidenceRecord` with filters `{creatorId, evidenceId}` projects the matching post from that creator's latest saved packet into the existing evidence-review screen. Current sourcing links use actual creator/run/post IDs. Existing historical v2/demo contracts retain their separate views.

All three response versions hash the returned read-model data. A stale/superseded readiness change therefore changes the response version while the original saved assessment identity remains stable. Model tables in a saved assessment describe the configuration used for that run; sourcing model summaries describe current bindings.

### Finance and payable reads (THO-303, THO-300; THO-367)

The initial baseline below is retained for the general accounting reader. Native commission, settlement and historical payable routes now use `settlements/reader.ts`; their current contract and canonical export/match recovery are described in the register's **Current settlement and fulfillment application contracts** section. Provider activation remains separate from application integration.

`financeDashboard`, `periodClose`, `monthsHistory`, `closePackage`, `reportManifest`, `commissionLedger`, `settlementDetail` and `payableDetail` are served by `src/creator-agent/finance/`. **Stage: sandbox, unconfigured source.** No QuickBooks or provider reader exists in this repository, so with the default configuration every one of these reads answers 503 `INTEGRATION_PENDING` with reason `FINANCE_SOURCE_UNCONFIGURED` and no data. The service never serves the demo fixtures and never synthesizes a figure or an empty success.

A private `financeSource` reader can be injected through the server options. Its answer is validated strictly: exact scope, view, period and record id; the frontend's per-view schema; a lease capped at the 24-hour D-13 accounting ceiling; and explicit coverage. Stale and partial answers keep their state, counts and reasons. Unknown values stay unknown. A source denial clears to a neutral 403, and source text never reaches a response. Filters are exact, with no `scenario`. Cursors are refused. Reader capabilities are denied, and no Pay, reconcile, close, sign-off or export action exists. The full outcome table is in `adapter-freeze-register.md`, under "Native finance and payable reads".

### Operations reads (THO-301; THO-367)

The current operations reader additionally binds home/reporting periods, validates independent milestone receipts and integrates canonical fulfillment proposal/recovery. See **Current settlement and fulfillment application contracts** in the register; the paragraph below describes the original unconfigured baseline, not permission to activate a source.

`operationsOverview`, `orderDetail`, `orderCustomer`, `shippingException`, `returnDetail`, `fulfillmentAnalytics`, `operationsShipping` and `opsHealth` are served by `src/creator-agent/operationsReads/`. **Stage: sandbox, unconfigured source.** No Shopify, Shippo or warehouse reader exists in this repository, so with the default configuration every one of these reads answers 503 `INTEGRATION_PENDING` with reason `OPERATIONS_SOURCE_UNCONFIGURED` and no data. The service never serves the demo fixtures and never synthesizes a figure or an empty success.

A private `operationsReadSource` reader can be injected through the server options. Its answer is validated strictly: exact scope, view and record address (`orderId`, `shipmentId` + `exceptionId`, `returnId`, `days`); the frontend's per-view schema, whose output is all that is returned; a lease capped at the 15-minute D-13 order-source ceiling; and explicit coverage. Stale and partial answers keep their state, counts and reasons. Unknown values stay unknown. `orderCustomer` never gives customer values to a reader role. A source denial clears to a neutral 403, and source text never reaches a response. Filters are exact, with no `scenario`. Cursors are refused. Reader capabilities are denied; for a reviewer the shipping decision, return task, close and customer reveal are held as not connected, and no action executes. The full outcome table is in `adapter-freeze-register.md`, under "Native operations reads".

### Team permission and invitation draft reads (THO-305, THO-298; THO-367)

`teamPermissions` and `invitationDraft` are served by `src/creator-agent/teamInvitationReads/`. **Stage: sandbox, unconfigured source.** No provider role register or TikTok Affiliate Center reader exists in this repository, so with the default configuration both reads answer 503 `INTEGRATION_PENDING` with reason `TEAM_PERMISSIONS_SOURCE_UNCONFIGURED` or `INVITATION_SOURCE_UNCONFIGURED` and no data. The service never serves the demo roles or draft and never synthesizes an empty success.

A private `teamInvitationReadSource` reader can be injected through the server options. Its answer is validated strictly: exact scope and view; the frontend schema (`teamPermissionsSchema`, the recruitment `invitationDraft` schema), whose output is all that is returned; a lease capped at 15 minutes; and explicit coverage. Stale and partial answers keep their state, counts and reasons. An unread invitation quota stays unknown. The team view carries no capability, and a source cannot add one, so recorded permission evidence is never presented as granting access. `sendInvitation` is denied to a reader and held as not connected for a reviewer. Nothing grants a role, assigns an owner or sends an invitation. The live team screen continues to use the PR #87 operations controls (`operationsControl`, section `team`). The full outcome table is in `adapter-freeze-register.md`, under "Native team permission and invitation draft reads".

### Creator intake (J01)

`POST /v1/intake` records one signup or discovery candidate and resolves it to a canonical creator, without scoring, inviting, messaging, reserving or paying. Reads are under `/v1/intake/events`, `/v1/intake/creators` and `/v1/intake/sources`. The source route permission, suppression list, reviewed crosswalk and Notion/Sheets sinks are injected through `intakeAuthority`; none is connected yet. See [`src/creator-agent/intake/README.md`](../src/creator-agent/intake/README.md).

### Reward redemption (THO-348)

`/v1/rewards/redemptions` prepares and reads one local redemption per mature J11 entitlement. The private `rewardDomain` binding composes native purchase/reconciliation with the one shared J04 and job runner. Actual founder approval, the current earned programme, provider evidence and exclusive money/physical-stock grants precede purchase; a direct legacy purchase route cannot execute. Uncertain native outcomes retain the original attempt. Sources remain unconfigured by default. See [`src/creator-agent/rewards/README.md`](../src/creator-agent/rewards/README.md).

### Canonical paid-media consumers

Private `mediaDomain` configuration composes the existing paid-media repository and contribution controller on the application's SQLite with shared J04 and bounded jobs. Registered actions cover paused native draft, publication, budget change, finite safety pause and local stage authorization. Exact approved account routing has no fallback. Legacy direct media approval, release, publication and mutation HTTP routes are not mounted; raw decision callbacks cannot execute.

The initial $1,500 stage is one pool across its exact account allocations. Recording the cap spends $0; each later source action needs its own exact current approval. Publication and increases revalidate the original stage authorization, exclusive lifetime-cap-plus-headroom reservation and all five conditions: qualified product, permissioned content, functioning checkout, attribution and fulfillment. A separate finite status-only pause retains its own current native permission and quota requirements when growth is held.

A native result must bind the original operation, account, manifest and attempt and match the requested settings. Mismatches remain uncertain until exact source readback. Provider rejection is a terminal recorded outcome, not successful publication or permission to resend. Reconciliation records positive original-attempt closure under current read authority; any later retry still needs current write preflight. Confirmed receipts and historical liabilities remain immutable.

Contribution and treasury use adopted inputs and actual retained commerce facts. Proposed costs, unknown cash and scheduled revenue do not release commitments. No source adapter, advertiser account, adoption, spend release or production activation is configured by this implementation. The full provider-specific reporting screens retain their own acceptance. See [`media/README.md`](../src/creator-agent/media/README.md) and [`mediaControl/README.md`](../src/creator-agent/mediaControl/README.md).

## Weight binding

The owner-approved `2026-11-04.launch-v1` website and TikTok bindings are versioned under `src/creator-agent/configurations/` and loaded by the launcher by default. They preserve the explicitly adopted route percentages, existing arithmetic and80/65 bands. Historical v2 fixtures remain unchanged and are never a fallback. An explicitly unbound embedded/test instance still reports unknown numeric configuration and cannot activate.

The approved phase rules allow preliminary invitation qualification from the required packet/floors/permission gates without a complete total. Activation requires complete source-supported ratings, all applicable stage evidence and a score of at least80. Noncritical numeric ratings without criterionEvidenceRefs stay unknown.

An optional private override binding file is an array of `{current, baseline, expectedBaselineHash}`. Both model objects must satisfy `modelConfigSchema` in `src/creator-agent/config.ts`. Use `digest(baseline)` to obtain the immutable canonical SHA-256. Both numeric digests must match, covering route model ID, criterion IDs/order/weights, critical criterion mapping, arithmetic and aggregate bands. Labels/version/approval references may evolve without changing numeric semantics. Mismatched baseline or numeric changes prevent startup.

The arithmetic calls the existing `scoreOf` function: weight × rating /5; no rescaling; incomplete evidence yields no total; complete totals use the existing rounding. Aggregate bands come only from the bound configuration. An actual approval reference and source baseline are required; synthetic test configurations do not authorize real acquisition.

## Evidence and decisions

The policy enforces exact source-native likes >200; three distinct independent posts over two publication dates; two meaningful on-brief use examples; and independent routine/demo floors of3/5. Missing data remains unknown. Content sourcing does not require a retail CTA or Shop anchor. Required identity/source/suppression/brief checks govern invitation; actual audience/terms/program/attribution/claims checks govern activation. Neither public interest nor a keyword comment is a verified order.

Evidence retains sampled points versus continuous intervals, heard versus ASR/caption/unassessed audio, observed actions versus claims/inferences, comment ordering/authors/prompting/overlapping categories, and recent-ten relevant unpinned metadata including ordinary/lower-like posts. Comparable view groups are not pooled across different definitions, windows or paid context.

SQLite writes are transactional, append-only, expected-version checked and idempotent. A key reused for different input is rejected. Revised evidence/terms must use a new revision label. Source evidence remains the reviewer's responsibility; schema validation is not a claim that the agent independently verified a native platform.

## Zapier connection

After deployment and login, use a server-side Zapier authenticated HTTP action to PUT a source-reviewed packet. Store the reviewer credential in the private connection, send the expected policy/config/revision and idempotency key, and retain the returned run ID. Retry the same request with the same key after uncertainty; reconcile a conflict before changing the key. A reader connection may inspect capabilities/results.

No Zap, schedule, provider connection, source-video browser permission or outreach is activated by this code. Do not place the credential in `VITE_` variables, client code, URLs, public examples or Linear. Localhost is not reachable by Zapier; connect only after a reachable TLS endpoint is verified.

## Verification

`npm run verify`, `npm run test:e2e`, and `npm run test:e2e:agent`. Tests use synthetic identities and source records, exercising the approved first active bindings as well as isolated custom/unbound configuration cases. The agent browser suite uses the actual HTTP/SQLite service through a loopback-only same-origin proxy, one browser worker and a fresh temporary database. It follows actual saved sourcing, assessment and evidence links and verifies authentication, persistence and outage behavior.
