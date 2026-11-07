# Canonical paid-media consumer

This server-only module compiles Meta and TikTok campaign manifests and consumes the shared J04 approval and bounded job services. Tests use fictional accounts, named principals, source decisions and native receipts. No provider connection, real decision, campaign or spend is configured by the module.

## Ownership and composition

`PaidMediaRepository` owns immutable campaign revisions, local mutation proposals, frozen domain material and per-attempt native history. It does not own approval or worker leases. `createMediaDomainBridge` supplies an `ApprovalRegistry`, registered actions and finite `DispatchHandler`s to the existing `ApprovalRepository`, `ActionService` and `DispatchGuard`. The same `JobRepository` owns run items, operation keys, attempts, leases, retry and reconciliation.

Registered actions are `media.createDraft`, `media.publish`, `media.changeBudget`, `media.pause` and the local `media.stageRelease`. Each native action is routed only by the approved manifest's exact account to its registered handler. Unknown accounts have no fallback. Stage release uses the actual internal governance account, not a combined or invented advertiser account.

The previous `createDraft`, `decide`, `publish` and `applyMutation` effect entrypoints refuse with `CANONICAL_MEDIA_ACTION_REQUIRED`. They cannot execute through a legacy decision DTO or safety-policy callback. Their old HTTP effect routes are not mounted. Pure preparation, inventory, mutation proposals and history remain local domain operations.

## Exact source and approval basis

The campaign manifest fixes the account, checkout and SKU, offer and claims version, creative content and rights hashes, destination, objective, event, attribution, schedule, targeting, bid parameters and monetary caps. Extra delivery budget, Max Delivery, auto-recharge and placement expansion are disabled. Route selection follows verified checkout evidence: Meta website purchase, TikTok Shop GMV Max, or TikTok website Smart+.

The injected `CanonicalMediaSource` supplies a scoped current permission, exact source/native versions, publication and safety generations, current five-gate receipts, and a source-owned synchronous final fence. It must enforce operation keys and native-version/safety-generation conditional writes. This interface requirement does not claim a live provider adapter is qualified.

The bridge resolves the same J04 proof used by dispatch. Publication and increases additionally revalidate the original shared stage authorization and all five conditions: qualified product and released stock; reviewed permissioned content; actual offer and functioning checkout; attribution, deduplication and refunds; fulfillment, support and cash. Missing, stale, withdrawn or mismatched facts hold execution. Current source leases may renew but cannot extend the immutable campaign or approval expiry. Native settings are compared with the exact manifest before publication.

## One native attempt and honest recovery

Before the native call, the domain saves the original approval binding, decision receipt, source snapshot and actual runner attempt identity. It then heartbeats and checks current approval, actor/worker authority, source permissions, required gates and retained resource grants immediately before the conditional call. No second approval, effect or resource ledger is introduced.

An applied readback must match scope, action, campaign, revision, manifest, request/payload hash, provider/account, operation key, binding hash and attempt. Its times must be valid and consistent. Native settings must match the exact desired effect: PAUSED draft, active/in-review publication, status-only pause, or exact requested budget with other material unchanged. A matching receipt identifier alone is insufficient. A mismatch stays uncertain without committing an applied receipt; original read-only lookup can recover it without another send.

Absence, null, malformed output or a denied lookup never proves nonexecution. Retry requires an exact, fresh, positively terminal `notApplied` receipt closing the original attempt. Applied native receipts remain immutable. Valid provider rejection records the native effect and a safe `providerOutcome: rejected` separately; it is not successful publication and never becomes a not-applied closure. Provider-specific rejection details remain in protected domain history; the shared result exposes only `PROVIDER_REJECTED`.

Reconciliation reads the original operation with current read permission and does not require new execution authority. Lost ACKs survive SQLite restart. Late results cannot undo a later confirmed safety pause or newer successful outcome. Provider receipts are namespaced by provider, account and environment.

## Finite safety authorization

`media.pause` uses its own exact shared J04 founder-and-second-person authorization. It binds one known native campaign and publication generation, PAUSED status only, current native version and safety generation, and at most one effect. It does not depend on growth-stage permission or product/checkout growth gates. Native permission, exact pause capability and source-owned quota remain required. A new publication generation needs new finite authorization. No broad policy callback manufactures a proof or grants unlimited pause cycles.

## Release stage

The implementation is exercised through actual SQLite/J04/runner fixtures. Production activation still needs qualified native source adapters, real named-actor and decision ingress, current gate sources, exact account capabilities, exclusive resource grants and adopted economics. A synthetic receipt does not satisfy those external gates. THO-346 reporting UI and provider enrollment are not claimed complete here.
