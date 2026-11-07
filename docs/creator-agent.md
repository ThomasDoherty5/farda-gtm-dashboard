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

### Overview and cross-channel analytics (THO-293)

`overviewSummary`, `attribution`, `paidMedia` and `customerJourney` are computed in `src/creator-agent/analytics/` from optional trusted readers on `analyticsSources` (`orders`, `adPlatforms`, `sessions`, `support`), with the reporting timezone in `analyticsTimezone`. They are ordinary `POST /v1/read` views: the same authentication, per-principal read admission, exact-scope envelope (`readSchema`) and shared error envelope (`apiErrorEnvelope`) as every other read. Filters accept only an optional `preset` (`last7Days`, `last30Days` default, `last90Days`; paid media also `rights` and `platform`); the envelope `period` is null or an event-time ISO date range. Anything else, a demo `scenario`, a cursor, a sort or a foreign workspace, account or environment is `INVALID_INPUT` (400) before any reader is called; a period that ends in the future, spans more than 366 days or is sent with a preset is `VALIDATION_FAILED` (400).

Every read answers 200. `data.sources` gives each source's own state (`current`, `noChange`, `partial`, `stale`, `error`, `neverSynced`, `unconfigured`, `unavailable` or `invalid`), and `sourceFreshness` carries the D-13 `freshnessState` per feed (an absent reader is `neverSynced` with `SOURCE_UNCONFIGURED`). Figures that depend on a missing, failing or malformed source are unknown with a reason; the others render, and the read is `partial`. Only a source answering for, or refusing, this scope fails the read (`SOURCE_SCOPE_DENIED`, 403). D-13 ages: orders 15 minutes, ad platforms 26 hours; sessions and support use a proposed 24 hours. Source clocks may run up to 2 minutes ahead; beyond that the source is `invalid` (`SOURCE_TIME_UNVERIFIED`), and an order placed later than that makes its channel unknown (`ORDER_TIME_UNVERIFIED`). The request time only chooses the reporting window: freshness, staleness, the skew allowance and asset rights expiry are judged at projection time, read from the clock after every source has answered (never earlier than the request time), so a limit or rights date that passes while a source is answering is applied.

Sources send no free text: references are opaque tokens, attribution windows are `{clickDays, viewDays}`, ticket categories and asset rights are enumerated, and an asset label is a code such as `AD-01` or is replaced by an alias. An order is counted once: native feeds are authoritative and a mirror is compared, never added; a row owned by the other channel is dropped; the same `canonicalOrderId` in both channels counts once and marks the read partial, as does a missing canonical identity across two channels. New retained customers are distinct `customerRef`s. Creator orders are discount-code orders whose code the source marks as a creator's; sitewide promotions are discount-code orders only. Net receipts are after refunds posted to date for orders placed in the period; refunds of earlier orders are a separate correction measure. Valid orders with $0 net stay in the AOV denominator (THO-196 "net receipts ÷ the defined valid order cohort"), and their count is disclosed. Each measure carries its `definition`. Platform ROAS stays per platform and excludes GMV Max, which is reported separately as not incremental. MER, blended CAC and contribution stay unknown because creator costs and landed costs are not read here. This module does not route `launchSnapshot`, `launchControl`, `launchReconciliation`, `campaignFunnel` or `metricDictionary`; those views keep their own routing.

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
