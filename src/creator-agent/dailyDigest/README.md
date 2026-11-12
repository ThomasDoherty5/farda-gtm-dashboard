# Daily exceptions digest

The existing reporting machine accepts one daily exception event using the locator
`daily-exceptions:YYYY-MM-DD` and the adopted programme version. The date is the
Pacific delivery date. Use the existing scheduler for 08:30 weekdays and for
additional days in a verified active cohort. The server validates the slot and
derives the previous Pacific calendar day for activity totals. A new digest can
start during its scheduled day. Recovery retains the original date and source
checkpoints. The server does not install a timer or a provider binding.

Bind the scoped source readers and the existing reporting programme under
`actionFoundation.reporting.dailyDigest`. Its source binding pins the source
reference, binding version, timezone and permission for each dataset. Readers
return allowlisted normalized rows with canonical source identity. They preserve
the source snapshot version, as-of time, observation time and pagination
continuation. Data from an incomplete page chain is withheld. A missing binding
or unavailable field remains visible in its section.

| Section | Owning source inputs | Digest filters |
| --- | --- | --- |
| Launch gates | Current task and pending approval records | Open overdue P0, next 48 hours, unassigned due within seven days, approvals waiting over 24 hours |
| Creators | Collaboration obligations and verified fulfillment and post state | Due follow-ups, past posting deadline, delivered samples awaiting post, data checks |
| Content | Review, rights and completed metric observations | Overdue review, rights expiring within seven days, live-post metric age |
| Commerce | Canonical orders, refunds and media stage evidence | Yesterday's valid orders, retained units, net receipts, refund events and ad spend, orders needing attention and released stage cap warnings |
| Support and stock | Open cases, product ratings, stock positions and sync observations | Open over 48 hours, yesterday's low ratings, available and low stock, stale or failed source checks |

Use source-owned net receipts after the applicable refund rules. Refund events
are also reported separately by occurrence time. Currency and minor-unit
precision are preserved. The digest summarizes known media cap evidence. The
existing incident producer owns real-time alert evaluation and delivery.
The freshness reader may include the last successful ad import with its
source-owned freshness verdict. Confirmed missed imports and overdue content
observations include the oldest affected success time in the digest. An import
that has never completed is shown explicitly. A partial read or a timestamp
later than the source observation cannot establish a missed import.

Pass only the locator and idempotency key to `POST /v1/reports/accept`, under the
existing reporting machine authority. A transient read returns bounded retry
timing. Retry the same date and key. Completed reads persist across restart.
After the bounded read attempts, unresolved sources appear as unavailable.
One complete empty digest produces one all-clear line.

Pass the returned report reference to the existing `work` and `reconcile`
operations. The shared reporter owns destination and owner checks, its one
message grant, receipt storage, deduplication and original-attempt recovery.
Read evidence is journaled in the same database. Each section uses a configured
source evidence link and typed counts, amounts and creator handles.

The configured machine integration tests exercise the production query,
aggregation and reporting code using controlled data and a synthetic transport.
Provider source activation and recurring delivery require the applicable
source-owned bindings. Unconfigured hosted service capability reports this
state explicitly.
