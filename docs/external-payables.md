# External payables

`src/creator-agent/externalPayables/` pays existing external fixed-fee liabilities: fees that were accepted before the commission-only policy took effect and are still due. It never creates, raises or relabels a fee. New acquisition stays commission-only. Commissions and fees that settle through TikTok or Collabs stay in their native route.

There is no server route and no real payment adapter. The payment provider, the liability source reader and the commission-policy reader are all injected. Tests use deterministic synthetic fakes.

## Pieces

| File | Role |
| -- | -- |
| `contract.ts` | Types for `Ref`, `Money` and `Evidence`, the liability source shape, the provider interface, intent states and reason codes. |
| `ledger.ts` | Pure eligibility rules and balance arithmetic. |
| `paymentIntent.ts` | What approval binds, and the deadline rule for uncertain submissions. |
| `matching.ts` | Pure statement-line matching. |
| `repository.ts` | `ExternalPayableRepository`, which stores liabilities, intents, attempts, receipts, adjustments, conflicts, the accounting policy and matches. |
| `approvalBridge.ts` | The J04 registry and the dispatch handler. |
| `fakes.testkit.ts` | `FakePaymentProvider`, a synthetic liability builder and the full test stack. |

## Eligibility

A liability enters the payable queue only when all of these hold:

- It was accepted before the commission-only effective time. While that policy is unknown, it is held.
- Its contract, invoice, deliverable and balance are known, read through a source method (API, export or authorized browser). A UI import or a manual entry is not source evidence.
- It is a fixed content fee owed to an external payee. Minimum guarantees and paid-hybrid terms are refused, whatever their label. So are fees larger than the accepted amount. Commissions and provider-owned or provider-funded fees are refused too.
- Its balance is above zero, and it agrees with the ledger. The ledger figure is the invoice amount, minus prior payments and our receipts (each counted once), plus returned funds.
- It shares no invoice or component key with another liability, and the invoice is not marked as paid.
- All its amounts are in one currency.

A malformed payload, or one that cites an account outside the configured accounts, is refused and nothing is stored.

## Paying

1. **Propose.** `proposeIntent` creates one intent for the full outstanding balance. Only one live intent may exist per liability.
2. **Reserve.** `reserveApproval` makes the intent live and returns the J04 command. Replaying the same key works only while the reservation stands.
3. **Approve.** Approval runs through J04 in the settlement phase. The approver must be a second person. J04 currently requires the founder for every settlement, which is stricter than D-5 (founder only above USD 500). Approval binds the payee identity and version, the amount, the currency, the component, the terms version, the payment route and the intent version. J04 accepts USD only.
4. **Dispatch.** Payments go through the existing `DispatchGuard`, which handles the budget and quota grants, the capability lease and the idempotent run. Before submitting, the handler re-reads the source and the intent by reference. It then records the attempt and its deadline in one locked transaction, fenced by the J04 proof, and only after that calls the provider.

Every caller, retry and executor channel uses the intent's one provider key. That covers concurrent clicks, Zap retries and the API or browser fallback. The provider must be idempotent on that key.

If the amount, payee, terms, component or route change while a payment is live, the intent is withdrawn and a blocking conflict opens. The same happens to a reserved payment that the liability no longer covers. A later outcome for a withdrawn intent is recorded as a `lateOutcome` conflict, and its receipts are kept.

## Outcomes

- **Submitted is not settled.** An accepted submission does not reduce the balance. Only a settlement receipt confirmed by the source does.
- **Uncertain.** A timeout or lost acknowledgement leaves the payment uncertain. An empty lookup counts as not applied only after the submission deadline plus the settle margin, on both clocks. After that, a retry goes through a renewed preflight and reuses the same key. An unavailable lookup leaves the payment uncertain.
- **Partial or failed.** Settled portions stay. The remaining balance needs a new intent and a new approval. A submission that is still pending stays live, even if part of it has settled.
- **Adjustments.** Reversals, refunds and returns link to their original receipt and add back to the balance. They never delete or replay the receipt, and they can't exceed it.
- **Over-settlement** and receipt identity mismatches open blocking conflicts.

`status(liabilityRef)` returns the ticket's output fields: `submissionRef`, `settlementReceipt`, `outstandingBalance`, `accountingMatch`, `paymentState` and `exceptionReason`.

## Accounting

This module invents no accounting or tax rule, and it does not imply that any accountant has reviewed it. Until the configured responsible owner adopts an accounting policy, `ingestStatement` returns `ACCOUNTING_POLICY_UNVERIFIED` and stores nothing. There is no default policy and no default owner.

Once a policy is adopted, a statement line matches a settled receipt only by its exact reference, amount and currency. Each receipt matches once. The match stores the adopted policy's version and its expense, liability and cash mapping. Lines that name no external receipt, such as native-provider payouts, are left unmatched.

Ingesting a statement has no provider. It cannot trigger a transfer, and it does not touch native settlement. Posting to QBO is not built yet.

## Storage

The tables are `external_payable_*`, on the shared agent SQLite, bound to the scope in `agent_scope`. Every write is one `BEGIN IMMEDIATE` transaction that reads the clock after taking the lock. No transaction awaits anything: source and provider calls happen between transactions. Commands carry idempotency keys. A replayed key returns the stored result, and a reused key with a different request is refused.

## Not done

- A real payment provider, liability source and commission-policy reader, plus their capability bindings and budget owner.
- Server routes and the frontend adapter. Mapping `status()` into the payable view is also left for later.
- Posting to QBO.
- Owner decisions: whether J04 should follow D-5 for settlements up to USD 500, and who the responsible accounting owner is.
