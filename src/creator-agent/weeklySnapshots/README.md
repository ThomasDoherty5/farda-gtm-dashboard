# Weekly KPI snapshots

The reporting machine accepts `weekly-kpi:YYYY-MM-DD` and the adopted reporting
policy version. The date is a Monday in America/Los_Angeles. Its completed
week starts at the previous local Monday midnight and ends at this Monday
midnight. The pre-read is due at 08:30 Pacific on the first Monday after
the approved launch date. The server installs no scheduler.

`actionFoundation.reporting.weeklySnapshots` binds the scoped source and
the existing reporting destination. The source supplies the exact week,
versioned definitions, distinct actual and planned measures, coverage and
as-of times. Cash actual, committed and remaining forecast must be disjoint.
Native platform ROAS is separate from order receipts and blended metrics.
Unknown inputs remain N/A. A zero comparator yields only an absolute change.
Ranked examples use scoped opaque labels.

The journal stores one immutable original. A trusted source job can pass a
correction receipt to `observeCorrection`. The source must resolve the exact
receipt and prior version/digest. Corrections append a revision and preserve
the original report and delivery checkpoint. The reporting machine reuses its
shared original-attempt lookup, owner, grant and receipt checks.

The native performance trend adds the frozen version only when the exact
unfiltered Pacific week, definition, channel amounts and source scope agree
with independently authorized order facts. A correction that has yet to
reconcile cannot label the chart. Only the public revision and opaque evidence
reference reach the existing chart.

The integration and browser tests use two fictional source weeks and the
actual application, SQLite and shared reporting service. Source deployment,
the launch date and native delivery to #ops-weekly are configured by their
owners. A controlled snapshot and report do not enable recurring delivery.
