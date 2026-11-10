# Mirror resync

`src/creator-agent/mirrorResync/` repairs one mirrored record from its authoritative source, when an operator explicitly asks for it. It builds on the reconciliation check in `src/creator-agent/mirrorReconciliation/` (see `mirror-reconciliation.md`). It has no server route and no real writer. The Zapier or Notion writer is injected later.

## Pieces

| File | Role |
| -- | -- |
| `contract.ts` | The injected `MirrorWriter` and `AuthoritativeSourceReader` interfaces, the read and write shapes, the request schemas, the states and the reason codes. |
| `detect.ts` | `detectRecordDifference`, which compares one record through `compareMirror`. There is no second set of comparison rules. |
| `repository.ts` | `MirrorResyncRepository`, which stores proposals, the audit trail and finding resolutions on the shared agent SQLite. |
| `service.ts` | `MirrorResyncService`, which runs an apply: reads, checks, the write and the read-back. |
| `fakes.testkit.ts` | `FakeMirrorWriter` and `FakeSourceReader`, deterministic fakes for tests. |

The comparator now also compares one mirrored field, `record-status`, and raises a `field` finding. It does so only for a dataset that declares the field in `mirroredFields`, and only when the source row carries a known status. No dataset declares it by default. A resync writes only the amount and the fields its dataset declares.

## Interfaces

- **`AuthoritativeSourceReader.read(ref)`** returns either `granted` access, a `complete` flag, the record (or `null`), a version (or `null`) and an observation time, or `denied` / `unknown` access with a reason.
- **`MirrorWriter.read(ref)`** returns the mirror row and its version, `absent`, or `failed`. A row holds the mirrored fields (`amountMinor`, optional `status`) and its `local` mirror-only fields.
- **`MirrorWriter.maxWriteMs`** is the longest a write can take to apply or fail. The service refuses to start unless `maxWriteMs` plus `settleMarginMs` (10 seconds by default) is shorter than `leaseMs`.
- **`MirrorWriter.write(request)`** is a compare-and-set on `expectedVersion`. `null` creates the row only if none exists. `set` holds only mirrored fields, and the writer must patch those fields, leaving every other field and its history alone. The request carries a `deadline` on the service clock, after which the write must not apply, and an abort `signal`. It returns `applied` with the new version, `conflict`, or `rejected`. Any thrown error, including `MirrorWriteUncertainError`, is treated as an unknown outcome.
- **The compare-and-set must be atomic in the provider.** Reading the version and then writing is not acceptable. A late write from an earlier attempt could then overwrite a later one, which is exactly what the compare-and-set must stop.
- **`MirrorWriter.readBack(ref)`** reads the row as the provider now holds it, bypassing any cache.

Every response is parsed. A malformed source response counts as unknown access, a malformed mirror read as a failed read, and a malformed write response as an unknown outcome.

## Flow

1. **Propose.** `propose` needs `intent: { kind: "operator-resync", operatorRef, reason }` and an idempotency key. It names an open reconciliation finding by check and plain fingerprint. The source must own the record, the category must be `amount`, `field` or `missing_mirror`, and the finding must name both read versions. Otherwise it is refused with `REPAIR_OWNERSHIP_HELD` or `RECONCILIATION_INCOMPLETE`, the same codes as the repair hold in `operationsControls.ts`. Only one unfinished proposal can exist per finding. Proposing reads and writes nothing outside the database.
2. **Apply.** `apply` needs the key, the same operator and `confirm: true`. It takes a lease on the proposal.
3. **Plan.** It reads the source and the mirror. Then, inside the lock, it refuses unless source access, completeness, version, identity and freshness (`maxSourceAgeMs`, 15 minutes by default) are all certain, and the mirror read succeeded for the same record. It detects the difference through the comparator. A record that already matches closes as `already_matched` without a write. Otherwise the plan fixes the source version, the mirror version, a digest of the local fields and the differing mirrored fields to write.
4. **Recheck.** It reads both sides again just before writing. If the source version or values moved, or the mirror version moved, the attempt ends as `conflict`.
5. **Write.** It fixes the write's deadline inside the lock, stores it, then writes with compare-and-set on the planned mirror version, with a write key that is unique to the attempt.
6. **Read back.** It always reads the mirror back. The finding closes (`verified`) only if the row changed, is the same record, its local fields are unchanged, and the comparator finds no difference against the planned source read. Otherwise the finding stays open with a reason.

The source can still change between the recheck and the write. A `verified` close is judged against the planned source read, not against a read taken after the write. If the source moved meanwhile, the next reconciliation run raises the new difference as a new finding.

## States

| State | Meaning | Next apply |
| -- | -- | -- |
| `proposed`, `refused`, `conflict`, `not_applied` | Nothing from this proposal is on the mirror. | A new attempt, from fresh reads. |
| `applying`, `uncertain` | The last attempt may have written. | Reads back only, never writes. |
| `verified`, `already_matched` | The record matches. The finding is closed. | Returns the recorded result. |
| `mismatch`, `cancelled` | Final. The finding stays open with the reason. | Returns the recorded result. |

`mismatch` reasons are `PARTIAL_APPLY`, `READBACK_MISMATCH`, `LOCAL_FIELDS_CHANGED`, `MIRROR_ROW_REMOVED` and `MIRROR_IDENTITY_MISMATCH`. A mismatch needs a person, so a new proposal is required.

## Uncertain writes and replays

- **Timeout or lost acknowledgement.** The service reads back at once. A changed row is judged as in step 6. An unchanged row is `uncertain` (`WRITE_OUTCOME_PENDING`) until the write's deadline plus `settleMarginMs` has passed, because the write may still land. Only after that does an unchanged row become `not_applied` (`WRITE_NOT_APPLIED`). If the read-back fails, the state is `uncertain` (`READBACK_FAILED`).
- **The next apply** on an `applying` or `uncertain` proposal only reads back and settles the attempt, under the same rule. It never writes. Only a later, explicit apply after `not_applied` tries again, as a new attempt with a new write key.
- **Replay** of a final proposal returns the stored result and reads or writes nothing.
- **Lease.** An apply holds the proposal for `leaseMs` (2 minutes by default), counted from its claim. A second apply meanwhile gets `RESYNC_IN_PROGRESS`. After the lease expires, an interrupted attempt is read back. If the old call finishes later, its result does not change the proposal. It is recorded as a `late_result` under its own attempt number, and the call fails with `RESYNC_LEASE_LOST`.

## Storage

The tables are `mirror_resync_proposals`, `mirror_resync_audit` and `mirror_resync_findings`. Each step is one `BEGIN IMMEDIATE` transaction that reads the clock after the lock is held. No transaction awaits anything. Reads and writes to providers happen between transactions, and each step re-asserts the lease, the proposal and the open finding inside the lock.

`auditTrail(proposalId)` lists every step of every attempt: proposed, planned, applying, the result, and refusals. Each entry has its versions, the fields written, the mirrored values before and after, and the local-field digests.

Each audit entry carries the number of the attempt that produced it, so a late result from attempt 1 is recorded as attempt 1 even after attempt 2 has started.

**`ResyncOutcome` and `auditTrail()` are server-side only.** They hold record keys, plain fingerprints and mirrored values, and a record key is guessable. Never return them to a browser or post them to a channel. Only a `repairReceipt` built from them goes outward.

The resync never writes the reconciliation tables. `findingResolution` is the resync's own view. The reconciliation check clears its copy of the finding on its next complete run, as it would for any other fix.

## Plugging into the repair proposal flow

`operationsControls.ts` already lists each snapshot conflict as a `repair` action, holds it (`REPAIR_OWNERSHIP_HELD`, `RECONCILIATION_INCOMPLETE`), and records an approval request through `proposeOperationsReview`. It expects a `repairReceipt` service evidence with `sourceReadbackVersion` and `mirrorReadbackVersion`. The backend owner would wire it like this, without changing that module's rules:

1. Build `MirrorResyncRepository` on the `MirrorReconciliationRepository` that feeds the snapshot. Build `MirrorResyncService` with the real writer and source reader, and the operations secret.
2. When a `repair` review for a conflict is approved, map the conflict's public id back to its plain fingerprint (through `findings(checkId)` and `reconciliationPublicIds`). Call `propose` with the approval's request key as the idempotency key and the approving operator as the intent. Then call `apply`.
3. Report the result as a `repairReceipt`: `verified` or `already_matched` as `applied`, `applying` or `uncertain` as `uncertain`, and the rest as `rejected`. Take `sourceReadbackVersion` and `mirrorReadbackVersion` from the final audit entry.
4. `repairAllowed` stays `false` in the snapshot until field-level ownership in the mirror is settled. Until then, the existing hold keeps the dashboard from offering the repair. The service checks ownership itself either way.

## Out of scope

- Field-level permissions in Notion, which need provider access.
- The real Zapier or Notion writer.
- Slack notification of results.

## Verification

All test data is synthetic. `service.test.ts` covers comparator-based detection, explicit intent, every source uncertainty, the recheck and the compare-and-set conflict, local fields and their history, and the audit trail with per-attempt numbers. It also covers replays, timeouts that stay uncertain until their deadline, lost acknowledgements, failed read-backs, lease expiry, a write stalled past its lease that lands late, the check of lease against write duration, partial applies, already-matched records, writing only declared fields, and the reconciliation check clearing its copy afterwards. It also checks that the clock is read only inside the lock, and that no transaction is open during a provider call.
