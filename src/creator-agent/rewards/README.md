# Creator reward redemption

The authenticated sandbox service stores redemption requests and source receipts in its scoped SQLite database. J11 owns the earned entitlement and its amount. J04 owns the founder decision. J15 owns physical inventory allocation. J16 owns applicable recovery cases. This module has no shipping, payment or accounting credentials.

## Request and decision

A reviewer can prepare a request at `POST /v1/rewards/redemptions`. The J11 source must identify a mature, unfulfilled entitlement, creator, program, milestone, currency and qualified time. Its reward version binds an adopted option or permitted equivalent. The request identifies the recipient, delivery route, expiring quote and exact all-in cap. Tax, shipping, booking and administration count toward that cap. A creator-funded upgrade remains separate. An active request also reserves the canonical creator/program/milestone when another source alias refers to it.

`POST /v1/rewards/redemptions/:id/decisions` reads the exact founder decision from the trusted J04 resolver. Its source, scope, approval time, request revision/hash and expiry must match. A Farda physical reward also requires a current J15 reservation matching the reward purpose, recipient and option. A revised request needs another decision.

## Purchase and recovery

`POST /v1/rewards/redemptions/:id/purchase` rechecks the entitlement identity and maturity, the adopted policy and selected option, the decision, request expiry, quote, funding and account binding. It persists a purchase key scoped to the exact request and a fenced execution lease before dispatch. A replay of a confirmed purchase returns the current receipt.

The executor must honor provider-side idempotency for that key. Its readback contract distinguishes a keyed `found` receipt from explicit `notFound` proof containing the same key, provider, bound account/route (`providerBindingRef`) and a fresh check. Purchase receipts carry that same provider identity. Outcome and cash resolvers receive the stored provider identity and must return it with every receipt; matching local order IDs alone are insufficient. Null, malformed, denied, expired or mismatched responses require reconciliation. They cannot authorize another purchase. A confirmed purchase can be recorded after authority changes. A new dispatch requires all current evidence and lease ownership again after any awaited readback. A terminal or ambiguous attempt is unavailable for direct purchase in the read model.

## Fulfillment and finance

Provider outcomes enter through `/:id/outcomes`. Physical source timestamps must follow purchase and prior physical fulfillment receipts. Each distinct refund receipt is counted once when its occurrence is on or after purchase and no later than now, regardless of receipt arrival order. Refunds adjust money separately from delivery. The maximum refund occurrence remains the lower bound for a cash posting; it never blocks an earlier valid physical event. A physical state or timestamp regression still fails closed. A failed or returned reward can release its milestone for a replacement after the charge is fully refunded. A refund while the shipment is still in transit keeps the original reservation.

`/:id/reconciliations` matches the scoped cash posting to the original provider order, transaction, charge and cumulative refund. Provider order, transaction, outcome and cash identities are namespaced by provider plus the account/route binding in the approved request. Different accounts can legitimately reuse local IDs; reuse within the same bound account remains held. A posted time cannot precede the purchase, an included refund or a prior cash reconciliation, or claim a future movement. Changed refunds require a new cash receipt. A qualified but undelivered award remains an outstanding obligation when an option or booking is delayed.

The two read routes are `GET /v1/rewards/redemptions/:id` and `GET /v1/rewards/entitlements/:ref/redemption`. Their views preserve the J11 entitlement/source identity, program and currency alongside the cap, reserve, outstanding liability, charge, refunds and settled cost. Receipt views expose the bound provider/account identity alongside local order and transaction references. Existing global receipt claims and history remain immutable. Exact historical command replays stay readable, while new source validation requires the bound identity. Legacy occurrence clocks are not reconstructed from ingestion history: missing purchase or physical timestamps hold the affected transitions. They expose the 30-day initiation clock separately from the request expiry. `executable` requires an approved request, an executor and currently valid authority. Proposed and unavailable states carry no purchase authority.

## Release stage

Automated tests use synthetic J11, J04, J15, provider and cash receipts and an in-memory executor. The default runtime has none of these reward authorities configured. Connecting canonical J11 entitlement reads, founder Linear decisions, inventory reservations, provider outcomes, J16 recovery and finance reporting requires their respective source owners. Production redemption, program adoption and a dashboard for the redemption view remain open.
