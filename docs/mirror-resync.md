# Verified mirror resync

The repair candidate in `src/creator-agent/mirrorResync/` uses the existing mirror comparator for record-level evidence. It is a server-side adapter candidate. A live repair requires the compiled `operations.repair` owner, exact J04 approval and a qualified writer under the existing source permissions.

## Writer contract

- A scoped read supplies the record identity, snapshot version, read time and authoritative watermark. The schedule declares the owned monetary measure and any mirrored status field. A missing, stale or ambiguous source read holds the repair.
- Immediately before dispatch the service compares both versions and the exact observed fields. The release fence checks the approved actor, action, scope, record and write payload. The writer enforces the current expected versions, the bound attempt key and its write deadline. A patch affects only the selected source-owned fields. A missing mirror row requires a conditional create for the canonical identity.
- The writer returns an authoritative outcome for the original command. An applied receipt identifies its resulting version. A no-effect receipt binds the original key and command digest, establishes complete closure and prevents a later effect from that attempt.
- After an applied outcome, both sides are read again. The finding can close after both fresh snapshots match and the local fields are preserved. Source-version drift, partial application and unknown readbacks leave an owned exception.

The reconciliation journal retains the original finding until its next complete matching comparison. The repair journal retains the scoped intent, attempts, affected fields, readback versions and outcome. Raw record identifiers, values and approval reasons remain server-side. The existing operations-control and Slack reporting paths can expose safe evidence.

## Uncertain outcomes

The same request and the same command identify the original attempt. The next call performs only original outcome lookup and readback while that attempt is uncertain. Time passing, an unchanged row or an unrelated matching edit cannot close it. A later explicit release can retry after the source proves the previous command cannot apply. The same target remains held across discrepancy categories until that proof exists.

## Integration

The read-only reconciliation view holds repair. Bind the approved provider/account and field ownership through the canonical operations owner. The owner supplies a synchronous release fence immediately before the effect and source-authorized original-attempt access for recovery. Use the existing dispatch and reporting services for production receipts and notices.

The current sandbox Notion PATCH demonstrates connectivity. The route lacks verified conditional-write and original-outcome support. [Notion's update-page contract](https://developers.notion.com/reference/patch-page).

The tests use fictional writer, approval and source evidence to exercise concurrent version changes, local-field preservation, partial application, exact replay and lost acknowledgement. A native release requires the same cases against the actual writer and permission boundary.
