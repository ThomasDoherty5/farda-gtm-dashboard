# Creator follow-up

`src/creator-agent/followUp/` holds the policy and state for following up a creator collaboration after terms are accepted: posting reminders, version-bound content review, paid reuse rights and closure. It proposes intents. It never sends a message, registers an action handler or serves a route.

## Inputs

The real posting clock will come from the Notion collaboration source. Until that source is connected, the module accepts only a posting clock event marked `origin: "synthetic"`, and synthetic delivery evidence that reuses the collaboration workflow's publication shape. Tests use synthetic identities only.

## Reminders

`decideReminder` is pure. It counts the current day in the configured timezone and compares it with the due day.

| Local day | Decision |
| -- | -- |
| More than two days before the due day | Wait |
| From two days before up to the due day | Creator reminder, step `due-minus-2` |
| After the due day, within the grace days | Creator reminder, step `within-grace` |
| After the grace days | Human review, step `past-grace`, with `expired` as the suggested closure |

A missing due date, grace period or obligation goes to human review. So does a timezone on the source that differs from the configured one. None of these produce a guessed deadline. Voluntary posting has no reminder. Creator reminders also need clear outreach eligibility and no unreconciled earlier send.

The due-date version is a hash of the due day, grace and timezone. A new source revision with the same date is the same version, and a changed date is a new one. The repository keeps at most one intent per collaboration, step and due-date version, enforced by a unique index. A proposed reminder that was never handed off is superseded by a later step, a newer due-date version or a closure.

## Content review

A review decision names the exact content version. A decision on any version except the current one is refused. A new submission returns the deliverable to pending review and drops the earlier decision, and a version can't be submitted twice. Closing as posted and verified needs visible native publication of the approved version.

## Rights

`evaluatePaidReuse` delegates eligibility to the asset store's `evaluateAssetUse`, so missing (`J09_RIGHTS_UNAVAILABLE`), expired, revoked, pending, stale or unknown rights block paid reuse in the same way. It adds a warning window ahead of the rights end date. The repository records at most one expiry warning per asset version, rights version and end date.

## Fees and closure

A creator reply that asks for a fee, or proposed terms that fail the commission-only rule, is a terms mismatch for human review. Nothing is auto-accepted. The closure reasons are posted and verified, declined, expired, terms mismatch, rights unavailable and cancelled. Each one needs its own evidence, and a collaboration closes once.

## Storage

The repository shares the scoped agent SQLite connection, which is bound through `capability_scope`. It owns the `creator_follow_up_*` tables. Every write runs under `BEGIN IMMEDIATE` with an idempotency key, and reads the injected clock only after taking the lock. A replayed key returns its original receipt. A reused key with a different request is refused.

## Actions

`actionAdapter.ts` produces envelopes in the shapes of the actions service's `foundationActionSchema` and of the collaboration workflow's `workflowIntentSchema`.

- A creator reminder becomes a `previewAction` that J04 binds to the exact intent version. Any send happens only through J04 approval and the existing runner.
- Approved, queued or running is not sent. Only a succeeded run with a receipt is recorded as sent.
- An uncertain send is never replayed. A dispatched run is reconciled with `reconcileRun` `lookup`, and an uncertain approval request with `reconcileApproval`. Without a run or approval reference, the intent is held for an operator. Leaving the uncertain state needs a terminal receipt for the same run.
- Human review items and closures become `human-handoff` and `close` workflow intents. The workflow's closure outcomes are coarser than ours, so the exact closure reason is kept in the reason text.

The action kind `creatorFollowUpReminder` is not registered. Registration, the real posting clock and message sending are left to their owners.
