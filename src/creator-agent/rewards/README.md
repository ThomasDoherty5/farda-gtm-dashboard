# Approved creator reward redemption — THO-348

This server-only module redeems a creator's earned reward once, after an exact J04 decision, and reconciles the receipts. J11 (THO-310) owns qualification, maturity and the entitlement amount. This module reads the entitlement through a trusted resolver and never recalculates it. It does not touch the reward ledger in `offers/rewards.ts` or the J12 fixed-fee lane.

It uses the scoped agent SQLite handle and creates only `reward_*` tables. Construct `RewardRedemptionRepository(db, scope, authority, now?)`. Every source is injected by trusted server configuration through `rewardAuthority`, never by a caller: the entitlement, reward terms, quote, provider route, J04 decision, outcome, cash movement and the purchase executor. None is connected yet. The tests use synthetic sources only, and no test makes a real purchase.

## Flow

1. **Prepare** (`POST /v1/rewards/redemptions`). Input: `entitlementRef`, `optionId`, `quoteRef`, `recipientRef`, `detailsCompleteAt` and `expiresAt`.
   - The entitlement must be mature, in scope and USD. Its amount is the all-in cap.
   - The reward terms version must be adopted, and the option must belong to the entitlement's milestone. An allowed equivalent is just another option in the adopted version.
   - The quote must match the option and provider, be available and in date. Item, tax, shipping, booking and administration all count against the cap. A creator-funded upgrade is recorded separately and never raises Farda's obligation.
   - The provider route must be Ready and its funding method verified.
   - Any problem holds the request with reasons and the provider's owner. Missing redemption details leave it `awaiting-details`. Otherwise it is `awaiting-approval`.
   - Re-preparing before purchase makes a new revision and clears any approval.
2. **Decide** (`/:id/decisions`). The J04 receipt must match the scope, redemption, revision and request hash, be current and in date, and be made after the request. A Farda-shipped item also needs an approved J15 allocation. A reserve or an earned entitlement is never purchase authority.
3. **Purchase** (`/:id/purchase`). The decision and the entitlement are checked again. The quote and the provider route are read again from their sources: a quote that is missing, unavailable, expired or different from the approved one refuses the purchase with `QUOTE_CHANGED`, and a route that is not Ready or whose funding is unverified refuses it with `PROVIDER_ROUTE_NOT_READY`. The caller's idempotency key is bound to this redemption's purchase; reusing it for anything else is `IDEMPOTENCY_KEY_REUSED`.
   - The state is committed as `purchasing` before the executor runs, with the key `purchase:<id>:r<revision>` and a five-minute lease. Another call during the lease is refused with `PURCHASE_IN_FLIGHT` and never reaches the provider.
   - An error or unreadable receipt leaves the redemption `uncertain`. A later call on an `uncertain` redemption, or on a `purchasing` one whose lease has expired (a stopped worker), reads the provider by that key first. It retries only if nothing was found and the approval, quote and provider route are still current.
   - A result is applied only while the redemption is still `purchasing` or `uncertain` under the same key. A late result never moves a redemption that has already moved on.
4. **Outcomes** (`/:id/outcomes`). Shipped, delivered, failed and returned are recorded in order from verified provider receipts. A refund is a money adjustment: it can arrive after purchase, shipping, delivery, failure, return or reconciliation, and keeps the state as it is. Only the refund that brings the refunds up to the charge moves the redemption to `refunded`. A refund with no recorded charge is refused with `NO_CHARGE_TO_REFUND`. A reward that was not fulfilled and is fully refunded frees the entitlement for a new request, and the earned obligation stays outstanding. A delivered reward can still be returned after reconciliation.
5. **Reconcile** (`/:id/reconciliations`). The posted cash must match the purchase transaction, the charge and the refunds. The same cash reference is idempotent. A different one is `ALREADY_RECONCILED` unless the refunds changed after the last reconciliation; then a new cash reference whose totals match reconciles it again and updates the settled cost. Every cash reference is kept in `receipts.cashRefs`, with the latest in `receipts.cashRef`.

Reads: `GET /v1/rewards/redemptions/:id` and `GET /v1/rewards/entitlements/:ref/redemption`.

## What the view shows

- `availability`: `proposed` until the owner adopts the terms, `unavailable` while held, otherwise `executable`.
- `promise`: copy bound to the actual option and cap, such as "$300 all-in allowance toward …" or "$5,000 toward a trip for two, with destination and dates chosen by the creator; …". It never states a retail value or an unlimited promise. Proposed terms are prefixed "Proposed, not yet adopted".
- `clock`: the qualified time and the details-complete time, kept separately. The initiation deadline is 30 days after the later of the two. Once a request passes that deadline it is marked overdue, and the earned liability stays outstanding.
- `money`: the cap, Farda's quoted cost, the creator-funded amount, reserve, earned liability, outstanding liability, charge, refunds and settled cost. These are kept as separate figures. A figure that is not known yet, such as the quoted or creator-funded amount without a quote, is `null`, never zero.

## Not done here

Real provider purchasing, J04 receipt resolution, J11 entitlement reads, cash posting, and the frontend view of a redemption are separate work. Owner adoption of the CEO-v1 reward terms is still pending, so every real redemption would show as proposed.
