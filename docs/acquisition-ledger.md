# Acquisition event ledger

The acquisition dashboard reads `pipelineSummary` and `pipelineBranches` from the authenticated adapter. Both return the same `evt-inv.v1` projection and scope. For the sandbox, an empty result means that no matching source observations have been recorded. The separate demo adapter serves the historical illustrative dataset.

## Producer contract

`POST /v1/funnel/events` accepts an authenticated reviewer request after the service's normal CSRF and scope checks. The envelope contains the job and version, observer identity, account, policy version, event digest, idempotency key, correlation and timestamps. The authoritative definitions and supported event types are exported by [funnelContract.ts](../src/creator-agent/funnelContract.ts). The producer hashes the parsed canonical event using the service's `digest` function. A registered, server-side `FunnelAuthority` must independently resolve the producer receipt for that same hash, workspace and account. Without that authority, the service refuses new events. Ingest records observations and never dispatches an action.

A provider may use its native event identity or a controlled fingerprint. A retry of the same native revision returns its original event reference. Reusing an event ID or idempotency key with different content conflicts. An authorized reconciliation names the previous event and a new immutable native version. A correction keeps the original opportunity and event type. SQLite persists the original receipt, correction and request lineage.

The acquisition source and the observing source are independent. For example, an opportunity recruited on Social Cat may later have an attributed sale observed by a website checkout. Carry the original acquisition reference and canonical opportunity across producers. An initially unresolved creator identity may be joined across sources using an independently verified crosswalk. Conflicting canonical identities require reconciliation.

## Read contract

Source/account, inbound or outbound direction, network, checkout, cohort ID/start interval, policy/offer versions, opportunity and as-of are typed filters. Intervals use UTC with an inclusive start and exclusive end. A snapshot includes only events both observed and persisted by its cutoff. Historical reads therefore reproduce the pre-correction evidence. A query that exceeds the event limit returns an explicit request to narrow its cohort interval. It never returns truncated counts.

Milestone counts use opportunities that have an actual event of that type. Conditional conversion divides mature opportunities with both eligible receipts by mature opportunities with the earlier receipt. Time-to-stage uses only valid known timestamp pairs. Current-stage counts instead partition the selected opportunities exactly once. Each row exposes its sources, owner, age, reasons and next action. All blockers remain visible, while only the primary blocker contributes to the disjoint exclusion totals.

Cost observations distinguish cash from accruals and preserve currency and source definition. Sample product, sample shipping, order costs, fees, task/model/runtime costs, commissions, refunds and rewards have separate buckets. Founder's time is measured in minutes. Cohort returns and retained value use canonical order identities and the most recent observed retained balance. Missing cost coverage or incompatible currency yields an unavailable contribution. Neither reach, post likes nor a predicted creator score is a sale.

Restart, source-key replay, mismatched input, historical corrections, mixed-provider identity, crossposts, due posting obligations, immature cohorts, missing source times, and real-adapter view states have fictional regression fixtures. None of those fixtures are seeded in the deployed database.
