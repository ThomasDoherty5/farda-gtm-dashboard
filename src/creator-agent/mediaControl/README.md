# Staged media governance and contribution controller

`MediaReleaseController` owns existing stage terms, observations, campaign exposure reservations, economics, treasury checks and incidents. The canonical media bridge consumes these records through shared J04 approval and job services. There is no separate approval, execution-lease or payment ledger. Tests use fictional sources only; no real media release or advertiser action is configured.

Legacy `decideStage`, `releaseStage`, `launch`, `applyChange` and `runSafety` write entrypoints refuse with `CANONICAL_MEDIA_ACTION_REQUIRED`. Local stage/change proposals, source observations and history remain usable. Proposals and historical released flags do not confer canonical execution authority.

## Shared stage authorization

The campaign envelope retains three held stages: $1,500 initial, $1,500 second and $3,000 third. Actual adopted parameters and dates are required. The first stage is one pool across its exact two-account allocation vector, not $1,500 per channel. Each later stage requires a separate exact authorization and its predecessor.

`media.stageRelease` is one actual local governance write under shared `mediaStageRelease`. It requires a named founder and a distinct requester/approver at every amount. Its manifest binds the internal governance ledger account, pool/version, sorted full allocation vector hash, USD cap, terms and gate sources. It records cap authorization, not spend: the item spends zero, consumes no stock and makes no provider call. No fictitious advertiser account or budget debit is used.

Publication and increases revalidate that original stage binding through the same `ApprovalRepository`. A stored receipt alone is insufficient. A pure observation that has not revalidated J04 reports `CANONICAL_STAGE_REVALIDATION_REQUIRED`; profitable observations cannot release a stage or extend immutable approval expiry.

## Exposure and resource ownership

The controller remains the exclusive owner of stage/account exposure reservations. The bridge exposes `reserveBudget` and `assertBudget` to compose with existing dispatch `ResourceAuthority`. Each grant binds the actual campaign, runner operation key, stage/pool version, account allocation, amount and expiry. Source-owned quota remains separate. No second resource debit is created.

The reserved maximum is lifetime cap plus adopted headroom, never daily budget alone. Stage and per-account allocations must both cover it. Committed campaigns count their approved maximum or actual spend, whichever is higher. Unknown caps, missing end dates, stale or mismatched reports, future times and untracked active campaigns hold growth.

Initial publication retains pending exposure until exact native reconciliation. Unknown outcomes retain that reservation. A confirmed campaign's later budget mutation retains committed exposure and confirmation time while a same-row pending key protects the new attempt. A positively closed mutation does not free a live campaign's prior commitment. Successful changes record the new learning-window time. Native application stores source-confirmed five-gate history; current gates are checked separately and history never grants current authority.

## Economics and treasury

Retained contribution uses canonical retained merchandise and shipping receipts less retained-unit landed COGS, fulfillment, marketplace/payment fees, earned affiliate commission, return allowance and other adopted variable costs. Proposed or missing inputs remain unknown. Historical obligations are not recalculated from a new acquisition proposal.

Scale checks require adopted loss/CPA limits, minimum evidence, attribution windows, review cadence and learning windows. GMV Max outcomes mixing organic and affiliate sales are excluded from incremental paid CPA unless exact incremental evidence is adopted. Native-attributed and canonical orders remain separate; corrections and refunds are retained.

Projected founder cash is `founder invested + max(0, commitments + remaining media authorization - (actual cash - working float))`. Only actual cash offsets the ceiling; scheduled payouts and revenue forecasts do not. Media already charged to cash is not counted twice. Unknown treasury inputs hold new commitments.

## Safety and remaining qualification

Observed stock, checkout, rights, measurement, exposure or loss breaches produce incidents and held growth recommendations. Actual pause execution uses distinct finite canonical `mediaSafetyPause` approval for a known native campaign/publication generation, with current permission, native version, quota and exact status-only write. A broad policy is not an execution grant. Revoked growth authority cannot disable an independently valid finite safety pause.

The composition is tested with real local SQLite/J04/job services and fictional source effects. Actual provider adapters, adopted parameters, live decisions, account permissions, reports, order/treasury/health sources and incident destinations remain external qualification gates. The full THO-347 reporting frontend or live source activation is not claimed complete.
