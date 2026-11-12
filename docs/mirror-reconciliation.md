# Mirror reconciliation check

`src/creator-agent/mirrorReconciliation/` compares source and mirror row sets and records each check. A trusted binding connects the existing job runtime and the authenticated `nightlyReconciliation` read. Source connections and job activation are deployment-owned. The comparison has no repair authority.

## Pieces

| File | Role |
| -- | -- |
| `contract.ts` | Input schemas, the check schedule record and result types. The comparison and conflict schemas come from `operationsControlSourceSchema` in `operationsControlsSchema.ts`. They are not copied. |
| `schedule.ts` | Local-day periods, cutoffs, due periods and the next run, all in the schedule's timezone. |
| `comparator.ts` | `compareMirror`, a pure comparator. `toOperationsControlSlice` turns a result into snapshot arrays. |
| `repository.ts` | `MirrorReconciliationRepository`, which stores schedules, runs and findings on the shared agent SQLite. |
| `runtime.ts` | Binds a daily observation registration and publishes its scoped dashboard read. |
| `report.ts` | Builds an aggregate event from the saved run for the existing reporter. |

## Check schedule record

A schedule has a `checkId` and a `version`. It also sets:

- an IANA `timezone`;
- a daily local `runAt`;
- `cutoffLagMinutes`;
- `coverage.lookbackDays`, the number of past due days each run rechecks;
- `expectedDatasets`, each with a scope, a grain, its amount field (`net-sales`, `label-cost` or `refund-total`) and the currencies always compared. A count-only dataset declares a null amount field. An owner can also declare `record-status` in `mirroredFields`.

A period is one local day. Its cutoff is the end of the day plus the lag. A period cannot be checked before its cutoff. `duePeriods` and `nextRunAt` derive the run plan from the record, including across DST changes. Where a DST change skips local midnight, as in America/Santiago or America/Havana, the day starts at the first instant after the skipped time. Where midnight occurs twice, the day starts at the first one.

The repository stores schedules by version. Saving the same version again does nothing. A different body under a stored version, or an older version, is refused. A run must name the current version.

## Inputs

A check input has a `runId`, the check and schedule version, the local-day `periods`, and source rows and mirror rows. Each row has a `key`, `scope`, `grain`, `period`, `currency` and an integer or null `amountMinor`. Null leaves a required monetary comparison incomplete. A `partial` row was observed with incomplete fields.

Dataset coverage is declared separately, per side, scope, grain and period, as `complete`, `partial` or `failed`, with a version, a `readAt` time and the source-owned `sourceAsOf` watermark. A dataset with no declaration is `unknown`. A complete snapshot requires a watermark at or before its read time. A watermark before the cutoff leaves the comparison partial even when the poll finished later.

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
| `field` | As for `amount`, but the mirrored `record-status` field differs. It is compared only when the dataset declares `record-status` in `mirroredFields` and the source row carries a known status. A mirror with no status column therefore shows no difference. Existing findings and their fingerprints are unchanged. |

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
- `mirror_reconciliation_group_basis`
- `mirror_reconciliation_run_findings`

Rechecks are idempotent:

- **Same run id, same input.** The stored run is returned, and nothing is written.
- **Same run id, different input.** The run is refused with `RUN_ID_REUSED`.
- **Repeated finding.** The fingerprint covers the check, group, key, side, category and field. Values, versions and times can change within one incident. Only `opened` and `reopened` findings contribute new alerts.
- **Clearing.** A complete comparison must show the affected record matches before the finding clears. A category change leaves the previous finding open. A cleared finding that returns is `reopened`.
- **Read order.** Each group retains the watermark of its latest complete comparison. An older observation cannot open, reopen or clear a finding, and the run records it as stale.
- **Periods outside the run.** A finding whose period is not in a later run stays open. It never disappears silently. Once its period has left the lookback window, it keeps the snapshot `partial` until a check that includes that period runs; a manual recheck of that period clears it.

`runs` returns the audit trail with its total. `runFindings` returns each run's dispositions. `findings` returns first and last run, occurrences, clearing and the read basis.

`latestSlice` builds the snapshot arrays from the latest run's comparisons and the check's currently open findings in those groups. It returns:

- `openFindings`, every open finding for the check;
- `unconfirmedOpenFindings`, open findings the latest run did not confirm, because their period was outside it, their group was not fully read, or its reads were older;
- `coverage`, which is `partial` for an incomplete or stale comparison, a truncated slice or an unconfirmed finding.

So a matched latest run cannot hide an open finding. Open findings that the latest run confirmed do not make coverage partial: that would hold every repair whenever a difference exists.

## Plugging it in

The server accepts a trusted `mirrorReconciliation` binding for one registered daily observe job. Its timezone and local time must match the recorded schedule. The source plan supplies one item whose subject is the check ID. The executor reads the periods due at the intended slot. It rechecks the source receipt and job authority before writing the journal. The existing runtime owns activation, quotas and retry limits.

Emit a mirror read declaration for every scope seen in the mirror or still covered by an open finding. Without it an orphan scope stays unknown. Use separate scope definitions for distinct monetary measures and keep count-only datasets separate from money. Preserve the authoritative source version and watermark for both sides.

The scoped read uses the existing operations-control adapter and its source permission fence. Named operations authority retains its existing precedence. A trusted report resolver can use the server's `mirrorReconciliation.report(runId, binding)` to derive the saved aggregate event. The existing reporter owns admission, delivery and receipt reconciliation.

Native dataset bindings and writer qualification require source-owned evidence. An unbound deployment remains held. The repair action stays disabled in this projection.

## Verification

All test data is synthetic.

- `comparator.test.ts` covers the schedule record, timezones and DST, including skipped and repeated midnights. It covers the six categories, currency separation, partial, failed and unread datasets, late reads, partial rows, overflow and known zeros. It also covers keyed public ids, orphan and open-group rechecks, input refusals, and parsing with the existing comparison, conflict and source-snapshot schemas, including the 100-item cap.
- `repository.test.ts` covers scope binding, the secret, schedule versions, idempotent replay and id reuse, suppression, clearing and reopening, orphan clearing, out-of-order reads, findings outside the run's periods, the audit trail, the snapshot slice and its coverage, the clock read inside the lock, and rollback.
- `runtimeIntegration.test.ts` covers scheduled admission, retry after a partial read, missing-row and amount drift through the authenticated read, reporting payload and permission withdrawal.
