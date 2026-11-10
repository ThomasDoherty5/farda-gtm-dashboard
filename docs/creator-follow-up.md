# Creator follow-up

`src/creator-agent/followUp/` holds the policy and state for following up a creator collaboration after terms are accepted: posting reminders, version-bound content review, paid reuse rights and closure. It proposes intents. It never sends a message, registers an action handler or serves a route.

## Inputs

The real posting clock will come from the Notion collaboration source. Until that source is connected, the module accepts only a posting clock event marked `origin: "synthetic"`, and synthetic delivery evidence that reuses the collaboration workflow's publication shape. Tests use synthetic identities only.

## Conflict with the collaboration workflow's reminder rule

The two reminder rules disagree, and the owner has to decide which one wins.

- **Collaboration workflow.** `intentHold` in `collaborationWorkflowSchema.ts` accepts a `reminder` proposal only after the grace period has elapsed. Before that it returns `POSTING_GRACE_NOT_ELAPSED`.
- **This module (`preDue`).** Creator reminders run from two days before the due day through the grace period. After grace, the collaboration goes to human review with `expired` as the suggested closure.

Neither path can reach the other's window. The workflow never reminds a creator before the deadline, and this module under `preDue` never reminds one after grace.

So the module has a required `reminderPolicy` setting with no default:

| Setting | Before grace ends | After grace |
| -- | -- | -- |
| unset | Creator reminders refused (`REMINDER_POLICY_UNSET`) | Refused |
| `preDue` | Reminders at `due-minus-2` and `within-grace` | Human review only |
| `postGraceOnly` | No reminder | One `post-grace` creator reminder, matching the workflow's rule, plus human review |

## Send paths

Each intent gets exactly one send path when it is created, and the other path refuses it.

| Intent | Send path | Reserve with | Then build with |
| -- | -- | -- | -- |
| `preDue` reminder (`due-minus-2`, `within-grace`) | `j04Preview` | `reservePreview` (returns the J04 envelope) | `previewActionFor`, for a retry only |
| `postGraceOnly` reminder (`post-grace`) | `workflowReminder` | `reserveWorkflowHandoff` | `collaborationProposalFor`: the workflow's `reminder` proposal |
| Human review (`past-grace`, `rights-expiry-warning`) | `workflowHandoff` | `reserveWorkflowHandoff` | `collaborationProposalFor`: `human-handoff` |

Every builder in `actionAdapter.ts` takes an intent reference and re-reads the intent from the repository. None of them accepts a caller's copy of an intent. This matters because `planReminder` is idempotent: replaying its key returns the receipt as first stored, including an intent that may have been withdrawn since. That copy can't become a send, because building anything from it re-reads the current state and refuses.

### Wiring a send

Both paths follow the same order. Whoever wires a submission must reserve first; without a reservation, nothing records the handoff between submission and the answer.

| Step | J04 path (`preDue`) | Workflow path (`postGraceOnly` and human review) |
| -- | -- | -- |
| 1. Reserve | `reservePreview(intentRef, key, { requestId })` | `reserveWorkflowHandoff(intentRef, key)` |
| 2. Build | Returned by step 1; `previewActionFor` rebuilds it for a retry | `collaborationProposalFor` |
| 3. Submit | `previewAction` to the actions service | `proposeCollaborationReview`, keyed by the returned `requestKey` |
| 4. Record the answer | `recordSendOutcome`, mapped with `outcomeFromActionResponse` or `outcomeFromActionError` | `recordWorkflowHandoff` |
| 5. Record what follows | `recordSendOutcome` for approval, dispatch and send | `recordWorkflowOutcome` for approved, rejected and sent |

**Reserve.** Each reservation runs in one locked transaction. It re-reads the intent, requires `proposed` on its own path, and moves it to a live reserved state: `previewing` on the J04 path, or `handingOff` on the workflow path. Either state counts from before submission, so a closure, due-date change or suppression during submission opens a conflict immediately.

**Repeat reservations.** A reservation under another key is refused with `INTENT_ALREADY_RESERVED`. A replay of the same key is idempotent only while the reservation still stands: `reservePreview` then returns the same envelope, and once the intent is withdrawn or has moved on, the replay is refused with `INTENT_NOT_PREVIEWING`. An answer recorded for an unreserved intent is refused with `INTENT_NOT_RESERVED`.

**Answers.**
- J04: an approval or a dispatch moves the intent on, and only a succeeded run with a receipt makes it `sent`.
- Workflow: a recorded proposal makes it `handedOff`, the stale-version refusal makes it `notSent`, and an uncertain answer makes it `uncertain`.
- Workflow detail read: `approved` makes it `workflowApproved`, which stays live because approved is not sent. `rejected` and `sent` are terminal.

**Unanswered reservations.** A reservation that is never answered, or an uncertain answer, is listed by `pendingReconciliation`. `reconciliationFor` holds it for an operator and returns the key to look it up with:
- `J04_PREVIEW_LOOKUP_REQUIRED` with the preview key, for J04's exact-key replay;
- `WORKFLOW_PROPOSAL_LOOKUP_REQUIRED` with the request key, for the workflow's `proposalRequestKey` lookup.

## Reminders

`decideReminder` is pure. It counts the current day in the configured timezone and compares it with the due day.

A missing due date, grace period, obligation or source timezone goes to human review. So does a source timezone that differs from the configured one. A missing source timezone is never filled in from configuration. Voluntary posting has no reminder.

A creator reminder also needs clear outreach eligibility. It is also held while an earlier creator message is any of these:

- awaiting approval
- in a live J04 hold
- dispatched
- handed to the workflow
- unreconciled
- in an open conflict The human-review escalation past grace is still proposed when a reminder is held.

The due-date version is a hash of the due day, grace and timezone. A new source revision with the same date is the same version, and a changed date is a new one. A unique index allows at most one intent per collaboration, step and due-date version.

## Withdrawn intents

An intent is withdrawn (`superseded`) in these cases:

- Closure withdraws every intent that isn't settled. That includes uncertain ones.
- A changed due date withdraws intents from older versions.
- Outreach suppression withdraws creator messages.
- Unknown outreach eligibility doesn't withdraw anything, so a failed lookup doesn't use up the reminder's slot. Instead it opens one blocking `outreachUnverifiedWhileLive` conflict for each creator message that is live in J04 or the workflow.
- A later step withdraws only proposals that were never handed to J04.

An intent counts as live in J04 when it is reserved (`previewing`), awaiting approval or dispatched. It is also live when it is held with an approval reference, because a J04 hold isn't terminal and can resume. An intent counts as live in the workflow when it is reserved (`handingOff`), `handedOff` or `workflowApproved`.

Withdrawing a live intent doesn't cancel it there. It opens a blocking conflict:

- `withdrawnWhileInJ04` or `withdrawnWhileInWorkflow` for an intent live in J04 or the workflow;
- `withdrawnWhileUncertain` for an intent whose send or handoff outcome isn't known, on either path.

An operator must cancel the approval, proposal or run with its owner, or reconcile the outcome, then resolve the conflict. A withdrawn uncertain or reserved intent stays in `pendingReconciliation` while its conflict is open.

### J04 current-draft check

Whoever registers `creatorFollowUpReminder` with J04 must make the registration's current-draft check (`currentDraft` / `assertCurrentDraft`) call `assertJ04Current(intentRef, intentVersion)`. That check must refuse a superseded intent. Otherwise J04 could still approve or dispatch a withdrawn reminder, because withdrawing here doesn't cancel anything in J04.

The preview binds `entityVersion` to `intentVersion` and `selectionRefs` to `[intentRef]`. `assertJ04Current` throws:
- `INTENT_WITHDRAWN` for a superseded intent;
- `INTENT_VERSION_CHANGED` for another version;
- `INTENT_NOT_IN_J04` for an intent that was never reserved or has settled.

The registration should pass this test, written in the shape of the repository tests:

```ts
it("refuses a withdrawn follow-up reminder in the J04 current-draft check", () => {
  const intent = repo.planReminder(plan(), "plan-1").proposals[0]!.intent;
  repo.reservePreview(intent.intentRef, "preview-1", { requestId: "request-1" });
  // In the registration, these two values come from the preview's selectionRefs[0] and entityVersion.
  const check = () => repo.assertJ04Current(intent.intentRef, intent.intentVersion);
  expect(check).not.toThrow();
  repo.close(collaborationId, { reason: "declined", sourceRef: "decline-1" }, "close-1");
  expect(check).toThrow("INTENT_WITHDRAWN");
});
```

Any outcome that later arrives for a withdrawn intent is stored as a `lateOutcome` conflict, and the intent stays superseded. This includes a real `sent` receipt or a `recorded` workflow answer, which stays in the audit log and never moves the intent to `sent` or `handedOff`. Every conflict except a late `notSent` blocks new creator reminders for the collaboration until it is resolved.

## Content review

A review decision names the exact content version. A decision on any version except the current one is refused. A new submission returns the deliverable to pending review and drops the earlier decision, and a version can't be submitted twice. Closing as posted and verified needs visible native publication of the approved version.

## Rights

`evaluatePaidReuse` delegates eligibility to the asset store's `evaluateAssetUse`. Missing (`J09_RIGHTS_UNAVAILABLE`), expired, revoked, pending, stale or unknown rights therefore block paid reuse in the same way.

The status is the first definite unavailability (revoked, expired or missing) along the chain, checking the asset first and then each ancestor. If no link is definitely unavailable, it is the first other non-granted status, such as unknown or pending. The expiry warning uses the earliest end date anywhere in the chain. The repository records at most one warning per asset version, rights version and end date, and dates it in the configured timezone.

## Fees and closure

A creator reply that asks for a fee, or proposed terms that fail the commission-only rule (`evaluateTerms`), is a terms mismatch for human review. Nothing is auto-accepted.

A collaboration closes once. `close()` parses its evidence and recomputes terms and rights itself, so it never trusts a supplied verdict. Closing as rights unavailable needs a definite `missing`, `expired` or `revoked` status. Unknown or stale rights don't qualify.

The collaboration workflow's `close` outcomes are coarser than these reasons. The adapter keeps the exact reason in the proposal's reason text.

| Closure reason | Evidence | `workflowIntentSchema.outcome` |
| -- | -- | -- |
| `posted-verified` | Visible native publication of the approved content version | `completed` |
| `declined` | Source reference | `declined` |
| `expired` | Posting clock past grace | `no-response` |
| `terms-mismatch` | Reply or terms, re-evaluated | `canceled` |
| `rights-unavailable` | Rights chain, re-evaluated as missing, expired or revoked | `canceled` |
| `cancelled` | Source reference | `canceled` |

## Storage

The repository shares the scoped agent SQLite connection, which is bound through `capability_scope`. It owns the `creator_follow_up_*` tables. Every write runs under `BEGIN IMMEDIATE` with an idempotency key, and reads the injected clock only after taking the lock. A replayed key returns its original receipt. A reused key with a different request is refused.

## Actions

`actionAdapter.ts` produces envelopes in the shapes of the actions service's `foundationActionSchema` and of the collaboration workflow's `workflowIntentSchema`.

- **`preDue` reminders.** `reservePreview` returns a `previewAction` that J04 binds to the exact intent version. The send then happens only through J04 approval and the existing runner.
- **Approved is not sent.** Approved, queued or running is never recorded as sent. Only a succeeded run with a receipt is recorded as sent.
- **Held approvals.** A blocked answer, or a denial that applied nothing, becomes `approvalHeld`, separate from a recorded approval.
- **Uncertain sends.** These are never replayed. A dispatched run is reconciled with `reconcileRun` `lookup`, and an uncertain approval request with `reconcileApproval`. With neither a run nor an approval reference, the intent is held for an operator.
- **Run binding.** The first signed run version stays the binding. Leaving the uncertain state needs a terminal receipt for the same run and version.
- **Workflow intents.** Human review items become `human-handoff`, the `postGraceOnly` reminder becomes `reminder`, and closures become `close` with the mapping above. Each is built only on its own send path, and only once reserved.

The action kind `creatorFollowUpReminder` is not registered. Registration, the real posting clock and message sending are left to their owners.
