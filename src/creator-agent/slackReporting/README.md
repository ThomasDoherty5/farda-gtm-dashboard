# Source-authorized operational reporting

This module formats and durably delivers one finite operational report through the existing `JobRepository`. It does not evaluate alert thresholds, schedule recurrence, approve a business action, or install a Slack connection. The default source is unbound and cannot send. Tests use synthetic source adapters and real SQLite job leases; they are not native Slack qualification.

`createSlackReporting({ db, scope, secret, jobs, source?, now? })` exposes:

- `accept({ eventRef, eventVersion }, requestKey, machine)`: read a trusted source event and adopted reporting programme, validate it, then atomically associate immutable report metadata with the existing job ingress.
- `work(reportRef, machine)`: obtain a fresh, exclusive one-message source quota grant for the exact command; activate and claim the compiled report handler; persist the original attempt in the job start transaction; deliver under final source, actor, quota and lease fences.
- `reconcile(reportRef, machine)`: read the original native key under current permission. It cannot interrupt a live lease or send a replacement. Null, malformed, absent, mismatched or incomplete evidence stays uncertain.
- `read(reportRef, machine)`: protected projection with opaque receipt/thread aliases and separate current holds. It never returns raw native IDs, message content, credential references or private source locators. Read-only eligibility remains unknown until the attempt grant is evaluated. Cost and task usage remain unknown.

The machine identity and callbacks are supplied by authenticated server composition, not a JSON request. Source assertions must be synchronous and source-owned. `deliver` must invoke its `context.assertCurrent()` after its last await and immediately before the native conditional write. The source adapter must honor the exact operation/attempt key, destination version, bot identity and programme grant; it must provide authenticated readback. `lookup` must invoke its read fence before the actual source read. No such adapter is installed here.

## Authority and state ownership

The compiled `deliver-report.v1` job uses the existing four-mode job protocol (`executeApproved`) with an explicit **report-policy** authority. It is not a J04 human approval, approved-business dispatch, observation or local artifact. Its receipt has `sourceEffect: internalReport`; it cannot release media, message customers or creators, spend money, move stock, or approve payments. The registered handler is excluded from generic job execution and legacy public admission.

The source owns the reporting programme, current ACLs, source incident transition, monotonic generation/sequence, aggregate window, destination mapping, owner state, source link authorization, not-before, exact quota allocation and capability binding. Red is immediate; orange uses the source digest window; info uses the adopted weekday/Monday 08:30 America/Los_Angeles slot. Hourly launch reporting requires a source-qualified launch window. There is no quiet-hours queue or independent threshold engine here.

The existing jobs tables own all queued/leased/held/completed/reconcile states, retry timing, attempts, resource locks and `dispatch_started` fencing. Report tables contain only immutable source/admission metadata, exact attempt commands/grants, and terminal native proof references. All metadata admission/start/settlement callbacks execute in those existing job transactions. Unknown effects do not expire into permission to retry.

One source incident generation has one root report and one recovery in its original thread. A later generation requires the exact preceding source-confirmed clear and its delivered recovery receipt. New transport keys or updated facts cannot duplicate the original breach. An uncertain attempt uses only its original key until exact positive terminal proof closes that attempt. A bounded fresh claim may retry after that closure and the source Retry-After time, under fresh authority; absence is never terminal proof. Late older attempts cannot overwrite a newer receipt.

## Privacy and truthful evidence

The strict formatter accepts finite operational labels, numeric values with explicit units/unknown reasons, safe order references or creator handles, finite next steps, a verified owner mention (or explicit unassigned state), and a source-authorized Linear issue link. It accepts no free-form errors, conversation/review bodies, customer names, email, addresses, health fields, arbitrary URLs, mass mentions or arbitrary message text. Exact private native IDs remain only in the scoped server database. The public projection distinguishes historical applied proof from current permission, and 401/403 never release protected response data.

An incomplete source cannot generate an all-clear. A report about a missing source may carry a finite `unknown`/`unavailable` fact only when the report event itself has complete, current evidence of that condition. Source writers and readers must remain independently qualified.

## Remaining activation and acceptance gates

Controlled SQLite tests are software evidence only. Actual authorized producer-to-adapter-to-Slack examples, exact source/programme/target bindings, complete granted-scope evidence, approved recurring windows, quota/usage facts, whole sandbox journey matrix, cutover authorization and production receipt remain separate gates. Existing harmless channel setup receipts do not authorize these operations. No source configuration, recurrence, extra Slack post, provider purchase or production activation is performed by this module.
## Automation failures

An authorized Zapier or registered-job source can normalize its terminal failure receipt with `automationFailureEvent` before returning a reporting snapshot. It supplies the exact scoped Zap, job, run, item, original attempt and checkpoint. Retry observations from the same attempt share the incident identity. A confirmed recovery uses the same identity and a separate source receipt.

The report shows aliases for source identifiers, a finite error category, the current recovery instruction, the assigned owner and the authorized Linear evidence link. A possibly completed action always directs the operator to reconcile the original attempt. A verified safe read or source-enforced replay may identify a checkpoint. A duplicate-trigger alert requires complete, scoped source receipts for two successful runs of the adopted migration window. The report itself grants no execution authority.

Configure `reporting.automationFailures` with the authorized receipt reader and synchronous current-source fence. Its results go through the existing reporter admission, destination check and original-thread receipt path. The source owner must bind actual Zapier error and billing observations. Missing budget evidence remains unknown.
