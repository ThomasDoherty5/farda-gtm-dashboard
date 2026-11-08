# Settlement and fulfillment application boundary

These views use the existing authenticated `/v1/read` and `/v1/action` adapter endpoints. They do not connect a payment, shipping or inventory provider by themselves. The default launcher supplies no qualified settlement or fulfillment plan source; those reads remain explicitly unavailable.

## Settlement reads and exports

`commissionLedger`, `settlementDetail` and `payableDetail` use the contracts in `src/creator-agent/settlements/`. Injected sources bind the current named principal, workspace, account, source revision, permission and observation lease. Historical paid receipts remain immutable; adjustments are separate facts. Whole-source state totals and contribution facts are supplied by the source, never inferred from a visible page. Missing values remain unknown.

`exportSnapshot` / `exportLedger` uses the existing ledger export job and artifact service. `ledgerExportRequest` is a pure lookup of the original request key, expected version and immutable payload. `ledgerExportArtifact` reauthorizes retrieval of the original artifact. A newer displayed ledger does not rebase an existing export. A failed or uncertain acknowledgment is recovered through its original key before any retry; CSV content comes from the authorized whole-source artifact, not browser table rows.

Statement matching uses the existing approval registry and execution owner. Provider-owned settlement views expose no duplicate manual payment operation. Current commission-only acquisition rules do not erase historical accepted fee liabilities.

## Operational reads

Operations overview, shipping, health and analytics accept exact home and reporting-window scope. A window includes start, end and timezone; partial or mismatched windows are rejected. Source snapshots must report that same cohort. Queue eligibility depends on independent order/sample approval, identity, stock, cancellation and label facts, and queue age uses the source request time. Unknown eligibility remains held.

Typed native events carry their own state, observation time, event time and receipt. A label does not establish carrier acceptance, delivery or replacement completion. A resolved return is displayed as verified only when the relevant inventory, remedy, accounting and case receipts all exist; a replacement also requires its shipment receipt. Free-form historical summaries cannot establish these outcomes.

Source links are scoped, allowlisted and lease-bounded. Synthetic, denied, expired or unqualified links remain unavailable. Protected operational content clears when authority is denied or its display lease expires. Coarse transport roles do not grant customer-data disclosure.

## Fulfillment proposal bridge

`fulfillmentProposal` accepts `{kind, targetRef, requestKey?}`, where kind is `shippingDecision` or `returnTask`. Without a key it reads current source-qualified plans. With a key it only reconciles the original proposal; it never prepares a new operation.

`previewAction` / `previewFulfillmentDecision` requires the exact source version, plan reference, named actor, reason and idempotency key. A plan supplies inspected quantities and evidence, disposition and one mutually exclusive refund or replacement, including the current balance or stock/address/cost bounds. The bridge saves an immutable request translation and delegates approval to J04. Existing J15/J16 owners retain all provider effects.

Recorded or uncertain intents are not approvals, refunds, labels, shipments or closed cases. Lost acknowledgments retain the original key. An unresolved target cannot be rebased under a new key, and a recorded plan revision cannot mint another approval identity. Recovery after a source revision changes requires fresh historical access. No raw proposal reason or provider credential is persisted in browser storage.

## Verification stages

Deterministic fixtures, authenticated application tests and provider-enabled operation are separate stages. Cloud tests exercise source fences, scoped reads, original-request recovery, canonical approval integration, native browser journeys and actual screen-reader output. Fictional authorities used by those tests must never be configured as live provider proof. Full design comparisons retain private originals outside the public repository and use only labeled synthetic rendered captures in public CI artifacts.
