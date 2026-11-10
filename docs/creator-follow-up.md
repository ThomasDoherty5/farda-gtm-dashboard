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

## Reminders

`decideReminder` is pure. It counts the current day in the configured timezone and compares it with the due day.

A missing due date, grace period, obligation or source timezone goes to human review. So does a source timezone that differs from the configured one. A missing source timezone is never filled in from configuration. Voluntary posting has no reminder.

A creator reminder also needs clear outreach eligibility and no earlier creator message that is dispatched, unreconciled or in an open conflict. The human-review escalation past grace is still proposed when a reminder is held.

The due-date version is a hash of the due day, grace and timezone. A new source revision with the same date is the same version, and a changed date is a new one. A unique index allows at most one intent per collaboration, step and due-date version.

## Withdrawn intents

An intent is withdrawn (`superseded`) in these cases:

- Closure withdraws every intent that hasn't been sent or become uncertain.
- A changed due date withdraws intents from older versions.
- Outreach suppression withdraws creator messages.
- A later step withdraws only proposals that were never handed to J04.

Withdrawing an intent that J04 is already approving or running doesn't cancel it there. That case opens a blocking `withdrawnWhileInJ04` conflict, and an operator must cancel the approval or run in J04 and then resolve the conflict.

Any outcome that later arrives for a withdrawn intent is stored as a `lateOutcome` conflict, and the intent stays superseded. This includes a real `sent` receipt, which stays in the audit log. Every conflict except a late `notSent` blocks new creator reminders for the collaboration until it is resolved.

## Content review

A review decision names the exact content version. A decision on any version except the current one is refused. A new submission returns the deliverable to pending review and drops the earlier decision, and a version can't be submitted twice. Closing as posted and verified needs visible native publication of the approved version.

## Rights

`evaluatePaidReuse` delegates eligibility to the asset store's `evaluateAssetUse`. Missing (`J09_RIGHTS_UNAVAILABLE`), expired, revoked, pending, stale or unknown rights therefore block paid reuse in the same way.

The status is the first non-granted one along the chain, checking the asset first and then each ancestor. The expiry warning uses the earliest end date anywhere in the chain. The repository records at most one warning per asset version, rights version and end date, and dates it in the configured timezone.

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

- **Creator reminders.** Each becomes a `previewAction` that J04 binds to the exact intent version. Any send happens only through J04 approval and the existing runner.
- **Approved is not sent.** Approved, queued or running is never recorded as sent. Only a succeeded run with a receipt is recorded as sent.
- **Held approvals.** A blocked answer, or a denial that applied nothing, becomes `approvalHeld`, separate from a recorded approval.
- **Uncertain sends.** These are never replayed. A dispatched run is reconciled with `reconcileRun` `lookup`, and an uncertain approval request with `reconcileApproval`. With neither a run nor an approval reference, the intent is held for an operator.
- **Run binding.** The first signed run version stays the binding. Leaving the uncertain state needs a terminal receipt for the same run and version.
- **Workflow intents.** Human review items become `human-handoff`, the `postGraceOnly` reminder becomes `reminder`, and closures become `close` with the mapping above.

The action kind `creatorFollowUpReminder` is not registered. Registration, the real posting clock and message sending are left to their owners.
