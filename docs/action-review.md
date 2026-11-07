# Native approval review and recovery

The approval and run pages consume the shared approval and job repositories. They do not create a second decision ledger, provider executor, or financial settlement route. A successful local artifact receipt is displayed separately from a provider operation acknowledgment; neither establishes delivery or a business outcome.

## Source-to-code mapping

| Existing source view | Native implementation | Source-state adaptation |
| --- | --- | --- |
| Approval detail, `6:234` | `ApprovalPage`, `NativeApprovalPage`, `NativeReview`, `NativeApprovalExecution` | Current field grants provide exact display text. Genuine immutable manifest versions and canonical execution links extend the existing approval layout. Missing protected fields remain unavailable. |
| Run approval, `5:13` | `RunPage`, `NativeRunPage`, `NativeReview`, `NativeRunRecovery` | Actual finite job items, receipts, checkpoints, and source-permitted context replace sample recipients and outcomes. Local artifacts, rejected provider results, and unresolved attempts remain distinct. |
| Recovery, `5:156` | `NativeRunPage` recovery tab and `NativeRunRecovery` | Typed source login, MFA, denial, throttling, failure, and uncertain-outcome context augments the existing recovery checklist. A current permitted source link is required before displaying a handoff. |

The existing design tokens, page shell, detail rows, cards, dialogs, and labeled horizontal table regions are reused. Native source state and additional audit details change content and page height; the native views do not claim pixel parity with sample-data originals. Full-frame original comparisons and source captures stay in the private handoff directory. Synthetic application captures use the normal browser-test artifact directory.

## Protected display and history

`actions/review.ts` accepts a server-owned, read-only source. The source snapshot must bind the authenticated named actor, scope, immutable manifest and item versions, payload hashes, provider account, decision receipt, and optional exact run. Every field and link requires an explicit grant. Source and actor leases bound display freshness. The final backing source assertion must complete synchronously; a Promise-returning assertion is rejected.

Only granted display fields reach the client. This interface must not contain credentials, customer health information, raw contact records, or session contents. Source links require a configured HTTPS origin and safe URL shape. The client renders text, never source HTML. Expired grants remove protected text and links; 401/403 clears protected query data. Protected review text is not written to browser persistent storage.

History is read from the approval repository's actual immutable versions. Selecting a historical version never substitutes the latest version or enables commands. Decision receipts remain immutable, while current eligibility and display access are checked separately. The approval's execution section is a bounded query of canonical runs for that exact manifest version; browser handoff history is not used as evidence.

## Existing control semantics

| Control | Native behavior |
| --- | --- |
| Version/history selection | Fetch the exact immutable version and its stored decision receipts. Show coverage and explicit current versus history mode. |
| Source approval handoff | Display only a current, permitted source URL. App-origin approval remains disabled under the source-origin policy. |
| Verify and record source result | Invoke the existing exact original-attempt lookup. The browser cannot assert that an effect happened or that an attempt is closed. |
| Continue guarded original work | Resume a paused run only when every unresolved original attempt has exact current closed-not-applied evidence. The worker still rechecks current authority and resources. |
| Keep paused / cancel unsent | Use existing job controls. In-flight, uncertain, and receipt-confirmed work is not erased. |
| Settlement reconciliation | Read-only, distinct historical manual, Collabs, and TikTok context. No generic Pay action or inferred transfer receipt. |

An absent attempt association is Unknown even when a separate historical effect receipt exists. An unattempted queued item is not labeled as an uncertain attempted effect. Accepted provider responses are operation acknowledgments; explicit provider rejection is terminal evidence and does not authorize a resend.

## Verification boundary

Focused source and UI tests cover exact field/link grants, source and actor withdrawal after awaits, synchronous final fences, immutable version history, current lease expiry, recovery state, and original-key controls. `e2e-agent/action-review.spec.ts` uses the actual authenticated service, temporary SQLite, shared approval policy, and separately authenticated worker with explicitly fictional source fixtures. It checks desktop/mobile layout, accessible dialogs, real keyboard table traversal, canonical execution readback, and original-attempt reconciliation.

These fixtures verify application integration. They do not qualify a real provider, grant a real source session, authorize an outgoing message, or establish a financial payment. Production use still requires the actual source owner and current qualified bindings.
