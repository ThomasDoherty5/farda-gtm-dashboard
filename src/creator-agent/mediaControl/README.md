# Contribution-based optimization and staged media release (THO-347)

This server-only module is the economic controller over native delivery. It observes, proposes, checks exact approval, executes bounded changes and reconciles. Every provider effect goes through the public methods of the THO-346 `PaidMediaRepository` (`read`, `publish`, `proposeMutation`, `applyMutation`, `readMutation`). It never calls a provider executor directly and never bids in an auction. THO-191 remains the importer of performance reports, and THO-193 owns versioned economics.

Construct `MediaReleaseController(db, scope, authority, media, now?)` on the scoped agent SQLite handle. It creates only `media_control_*` tables and checks `agent_scope`. Every source is injected by trusted server configuration through `mediaControlAuthority`, never by a caller. The sources are adopted parameters, the stage J04 decision, spend reports, canonical orders, health and treasury. None is connected yet. The tests use synthetic sources only, and nothing spends money.

## Modes

1. **Observe** (`POST /v1/media-control/stages/:ref/observations`) reads every source and persists an observation. It records cumulative spend per campaign, pending authorizations, the planned maximum, reporting freshness and source corrections. It also records economics, health, treasury, safety triggers, holds and recommendations. A pending launch is reconciled from the media record and the report. Observing never mutates the provider.
2. **Propose.** `POST /stages` records one stage's exact terms: ordinal, cap, overdelivery headroom, dates and per-account allocations. Every stage starts held. The cap must equal the adopted stage policy for that ordinal. `POST /stages/:ref/changes` records a proposed increase, reduction or pause with its rationale and evidence observation.
3. **Exact approve.** `POST /stages/:ref/decisions` needs a current Linear J04 decision for this stage, revision and terms hash. Slack or Notion is refused, and a decision is used for one stage only. Campaign publication and budget changes need their own THO-346 J04 decisions.
4. **Bounded execute.** `POST /stages/:ref/release`, `/launches` (`{campaignId}`), `/changes/:id/apply` (`{decisionRef}`, or `{policyRef}` for a pause) and `/safety` (`{policyRef}`).
5. **Reconcile.** After each write, the controller reads back the state the media module confirmed with the provider. A launch commits only on a confirmed campaign with all five gates verified. A change records its before and after native state.

Every POST needs the reviewer role and an `Idempotency-Key` bound to one operation and target. Errors use the canonical envelope. When a media write may already have reached the provider, the envelope is `executionCertainty: "uncertain"`, never `notApplied`.

## Staged release

- The $6,000 envelope is three held stages: $1,500 initial, $1,500 second and $3,000 third. Each needs its own exact decision and release, and stage N is released only after stage N−1. Profitable evidence never releases a stage.
- Release and launch run only inside the adopted review window. They need a current stage decision, no safety trigger or hold, and the founder cash ceiling respected.
- A launch needs a THO-346 campaign with its own J04 publish approval, inside a stage allocation and schedule. Its planned maximum is the native lifetime cap plus approved headroom. That maximum is reserved in the same SQLite transaction that re-observes exposure, so concurrent launches cannot both consume the same remaining authorization. The media module then re-checks its decision, sources and all five gates before publishing. A refused write frees the reservation. An uncertain write (including the media module's `MediaWriteUncertain`) keeps it reserved until reconciled and answers `executionCertainty: "uncertain"`. A pending publish superseded by a confirmed pause is closed by the media module without a send, and its reservation is freed.
- **Exposure.** Stage and account exposure is each committed campaign's native lifetime cap plus headroom (or its spend, if higher), plus pending reservations. An account spend limit bounds it too. Daily budgets are never a ceiling. Any of these makes exposure undemonstrated and holds new dispatch: an unknown cap, a missing end date, stale, future-dated or mismatched spend, or an untracked active campaign in a stage account.

## Safety

Safety triggers pause live spend under a pre-authorized THO-346 safety policy at any time, never limited by the review cadence. These conditions trigger a pause:

- an exhausted stage or account cap;
- overdelivery beyond the approved headroom;
- a native cap above the approved one;
- Max Delivery, auto-recharge or extra delivery budget enabled;
- a qualified-stock shortage, failed checkout, revoked or expired rights, unavailable permission or untrustworthy measurement;
- the adopted maximum test loss reached;
- a revoked stage decision.

Unknown health, unknown treasury, stale spend and an expired decision hold new dispatch without pausing.

A failed or uncertain pause opens a `PAUSE_FAILED` incident that holds dispatch until a later run confirms the pause. A condition incident closes when a later safety run no longer observes the condition. Incidents carry the stage's Linear decision reference, so a Slack incident can link the canonical decision. A confirmed pause supersedes any older increase, and a paused campaign is never published again. Incurred spend and earned commissions stay recorded.

## Economics

- Retained contribution per canonical order is retained merchandise plus retained shipping collected, less landed COGS for retained units, fulfillment, payment or marketplace fees, the affiliate commission and the return allowance (open return window only), less other variable costs. A commission is the actual accrual when reported, otherwise the adopted rate.
- Every cost input must be adopted, with an adoption reference. A proposed value, such as the 20% commission or 5% returns, stays unknown, and so does a COGS component listed twice. Unknown contribution is null, never zero.
- The allowable acquisition cost is adopted retained contribution per matched order. Scale criteria need known contribution, adopted minimum evidence and a canonical CPA within that cost. The diagnostic learning loss (spend less contribution) is checked separately against the adopted maximum test loss. No benchmark ROAS, CPA or lifetime value is assumed.
- Platform-attributed purchases are deduplicated across native and mirror events. They are reported apart from canonical orders and never added to them. GMV Max is flagged as including organic and affiliate outcomes, and `incrementalPaidRoas` is always null. Late refunds and late conversions are recorded as corrections.

## Treasury

The projected founder cash invested is:

founder invested + max(0, commitments + remaining media authorization − (actual cash − working float))

It must stay at or below the adopted $40,000 ceiling. Remaining media authorization is each released stage's cap less known spend. Scheduled payouts and revenue forecasts are reported but never counted. An unknown figure refuses.

## Clocks and identity

The controller keeps three clocks apart: the provider's data-as-of time, Farda's read time and the controller clock. A future or invalid timestamp is unknown. An older report never moves spend backwards. A newer lower figure is recorded as a correction. Provider-local IDs are namespaced by kind, provider, account and environment. A media read-back counts only when its campaign, provider, account and environment match the reservation.

## Not done here

This module does not include real report, order, health or treasury connections, the J04 resolver (THO-321), Slack incident posting or a frontend view. A pending launch whose current checks fail is not re-sent. It stays reserved until an observation reconciles it from the media record or the report.
