# Mirror reconciliation check

`src/creator-agent/mirrorReconciliation/` builds the reconciliation `comparisons` and `conflicts` from source and mirror row sets. Until now, the operations-control snapshot arrived with comparisons already computed. This module computes them, records each run, and keeps findings across runs. It has no server route, no provider reader and no repair.

## Pieces

| File | Role |
| -- | -- |
| `contract.ts` | Input schemas, the check schedule record and result types. The comparison and conflict schemas come from `operationsControlSourceSchema` in `operationsControlsSchema.ts`. They are not copied. |
| `schedule.ts` | Local-day periods, cutoffs, due periods and the next run, all in the schedule's timezone. |
| `comparator.ts` | `compareMirror`, a pure comparator. `toOperationsControlSlice` turns a result into snapshot arrays. |
| `repository.ts` | `MirrorReconciliationRepository`, which stores schedules, runs and findings on the shared agent SQLite. |

## Check schedule record

A schedule has a `checkId` and a `version`. It also sets:

- an IANA `timezone`;
- a daily local `runAt`;
- `cutoffLagMinutes`;
- `coverage.lookbackDays`, the number of past due days each run rechecks;
- `expectedDatasets`, each with a scope, a grain, its amount field (`net-sales`, `label-cost` or `refund-total`) and the currencies always compared.

A period is one local day. Its cutoff is the end of the day plus the lag. A period cannot be checked before its cutoff. `duePeriods` and `nextRunAt` derive the run plan from the record, including across DST changes. Where a DST change skips local midnight, as in America/Santiago or America/Havana, the day starts at the first instant after the skipped time. Where midnight occurs twice, the day starts at the first one.

The repository stores schedules by version. Saving the same version again does nothing. A different body under a stored version, or an older version, is refused. A run must name the current version.

## Inputs

A check input has a `runId`, the check and schedule version, the local-day `periods`, and source rows and mirror rows. Each row has a `key`, `scope`, `grain`, `period`, `currency` and an integer `amountMinor`. It also has a row-level `read` flag: a `partial` row was seen, but its amount is not trusted.

Dataset coverage is declared separately, per side, scope, grain and period, as `complete`, `partial` or `failed`, with a version and a `readAt` time. A dataset with no declaration is `unknown`. A `complete` read that finished before the period's cutoff may have missed late rows, so it counts as `partial`.

## Comparison rules

Rows are grouped by scope, grain, period and currency. Currencies never share a group or a total. Every expected dataset gets a group for each period and expected currency, even with no rows. That makes a complete read with no rows a known zero. Money is integer minor units. A total that leaves the safe-integer range becomes `null`, and its group becomes `incomplete`; the rest of the run continues.

A group with open findings from earlier runs is compared again whenever its period is in the run, even with no rows. That lets a finding in an unexpected currency or an orphan scope clear.

For each group, the comparator compares counts, money totals and keys. It classifies differences as follows.

| Category | Raised when |
| -- | -- |
| `missing_mirror` | A source key is absent from the mirror, and the mirror read is complete. |
| `missing_source` | A mirror key is absent from the source, and the source read is complete. |
| `orphan` | A mirror row belongs to a scope and grain that no expected source dataset owns. The source side of that group is a known empty set once the mirror read of that scope is complete, so the group can match and its orphans can clear. Without that mirror read it stays `unknown`. |
| `duplicate` | A key appears more than once on one side. Duplicates are counted within each side. |
| `amount` | A key appears once on each side, both reads and both rows are complete, and the amounts differ. |
| `field` | As for `amount`, but the mirrored `record-status` field differs. It is compared only when the source row carries a known status, so rows without one behave as before. |

A finding is raised only when the reads prove it. A partial source read cannot show that a mirror key is missing from the source. A complete mirror read can still show that a source key is missing from the mirror.

Keys are matched within a group. A key labelled with the wrong currency or period on one side lands in two groups and shows as two findings, one missing on each side, not as a single key-level conflict.

Conflicts carry no record key, and their ids cannot be used to recover one. A record key is guessable, so a plain digest of it and the other public inputs could be reversed by trial. The public comparison and conflict ids are therefore an HMAC under a server-held secret, the operations secret. The plain fingerprint used for suppression stays in the server database and in server-side results; it is never put in a conflict. Rotating the secret changes every public id but not local tracking: open findings are looked up and cleared by their stored group (scope, grain, period and currency) and plain fingerprint. A repeat refreshes a finding's stored ids, and `latestSlice` publishes every comparison and conflict under the current secret. Conflict values are presence, count, money or state, using the closed shapes in `safeValue`. Ownership is `source` for expected datasets, and `unknown` for `missing_source`, `orphan` and anything in an orphan group. `repairAllowed` is always `false`, because repair is owned elsewhere. The existing repair hold in `operationsControls.ts` therefore stays in force.

## Partial reads are never clean

A group's coverage is the worst of the two reads and its rows: `failed`, then `unknown`, then `partial`, then `complete`. Counts and totals for a side that was not completely read are `null`, never `0`. A group's outcome is one of these:

- `matched`: complete, with no findings;
- `differences`: complete, with findings;
- `incomplete`: partial coverage;
- `unknown`: unread or failed, including an orphan group whose mirror scope was not read.

A run is `matched` only when every group matched. If any group is incomplete or unknown, the run is `incomplete`, even when no differences were found.

## Runs, findings and suppression

`recordCheck` runs one `BEGIN IMMEDIATE` transaction. It reads the injected clock inside the lock and uses that time as the run's `observedAt`. A failure rolls the whole run back. The tables are:

- `mirror_reconciliation_schedules`
- `mirror_reconciliation_runs`
- `mirror_reconciliation_findings`
- `mirror_reconciliation_run_findings`

Rechecks are idempotent:

- **Same run id, same input.** The stored run is returned, and nothing is written.
- **Same run id, different input.** The run is refused with `RUN_ID_REUSED`.
- **Identical finding.** A finding's fingerprint covers the check, group, key, side, category, field and values. It excludes versions and times. Because values are included, a changed value is a different finding: the old one clears and the new one opens. A new run that sees an open finding counts it as `repeated`, and it is not raised again. Only `opened` and `reopened` findings are returned in `raised`, so alerts carry only those.
- **Clearing.** An open finding is `cleared` only when a later run compares its group with complete coverage and no longer sees it. An incomplete or unknown recheck leaves it open. A cleared finding that returns is `reopened`.
- **Read order.** Each finding keeps the newest `readAt`, per side, of the reads behind its current state. Runs can be recorded out of order, so a run whose reads of the group are older cannot clear or reopen it. That is recorded as `stale`.
- **Periods outside the run.** A finding whose period is not in a later run stays open. It never disappears silently. Once its period has left the lookback window, it keeps the snapshot `partial` until a check that includes that period runs; a manual recheck of that period clears it.

`runs` returns the audit trail with its total. `runFindings` returns each run's dispositions. `findings` returns first and last run, occurrences, clearing and the read basis.

`latestSlice` builds the snapshot arrays from the latest run's comparisons and the check's currently open findings in those groups. It returns:

- `openFindings`, every open finding for the check;
- `unconfirmedOpenFindings`, open findings the latest run did not confirm, because their period was outside it, their group was not fully read, or its reads were older;
- `coverage`, which is `partial` when the slice was truncated or any open finding is unconfirmed.

So a matched latest run cannot hide an open finding. Open findings that the latest run confirmed do not make coverage partial: that would hold every repair whenever a difference exists.

## Plugging it in

The server is not wired; the backend owner makes that change. A source reader for the `nightlyReconciliation` view would work like this:

1. Build `MirrorReconciliationRepository` on the same `db` and `scope` that `createOperationsControls` receives, with `secret: operationsSecret` and the same `now`, as the other modules in `server.ts` do.
2. Save the schedule record. On each scheduled run, read the source and mirror datasets for `duePeriods(schedule, now)`, and call `recordCheck` with their rows and coverage declarations. Emit a mirror read declaration for every scope seen in the mirror and for every group with an open finding (`findings(checkId, "open")`), not only the expected datasets. Without one, an orphan group stays `unknown` and its findings cannot clear.
3. In the injected `OperationsControlSource.read`, take `repo.latestSlice(checkId)`. Put its `comparisons` and `conflicts` into the snapshot, and use its `coverage` as the snapshot coverage. The schema allows 100 of each, and groups with differences come first.

`operationsControlSourceSchema` already accepts the output unchanged. The browser aliasing in `operationsControls.ts` applies as it does today.

## Out of scope

- Provider reads, a real sandbox mirror row and Slack delivery need provider access.
- Repair and its ownership policy have a separate owner.

## Verification

All test data is synthetic.

- `comparator.test.ts` covers the schedule record, timezones and DST, including skipped and repeated midnights. It covers the six categories, currency separation, partial, failed and unread datasets, late reads, partial rows, overflow and known zeros. It also covers keyed public ids, orphan and open-group rechecks, input refusals, and parsing with the existing comparison, conflict and source-snapshot schemas, including the 100-item cap.
- `repository.test.ts` covers scope binding, the secret, schedule versions, idempotent replay and id reuse, suppression, clearing and reopening, orphan clearing, out-of-order reads, findings outside the run's periods, the audit trail, the snapshot slice and its coverage, the clock read inside the lock, and rollback.
