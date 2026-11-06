# Saved operations and schedule drafts

These views use the existing authenticated creator-agent service and SQLite store.
They describe locally saved operations, not a complete inventory of provider activity.
An empty store does not establish provider readiness. No endpoint here enables a
schedule or dispatches a provider action.

## Paginated reads

`POST /v1/read` accepts the ordinary adapter envelope with `viewKey` set to
`connectionsOverview`, `channelCapabilities` or `automationRuns`, `period: null`,
`sort: []` and `page: { cursor: null, limit: 1..100 }`. Supported display-context
filters are `tab`, `q` and `state`; they bind continuation to the current view
context. The client filters the loaded rows. Coverage totals describe the saved
ledger, not the number matching those display filters.

Continue with the returned `page.nextCursor` and the same view, filters, limit and
authenticated role. Cursors are encrypted, scoped and expire after 15 minutes.
Key material is generated and persisted privately in the scoped SQLite store,
separately from reader/reviewer client authenticators. Schedule links survive
ordinary service restarts. Database backups contain that key and remain private.
The first rollout replaces the earlier credential-derived display aliases; an
old saved-view selection link may require reselection. Native source IDs and
stored operations are unchanged.
Membership is fixed by the first page's database watermarks. Later inserts appear
on a new first-page read. Permission, verification, health and job state are read
again for each returned row. This is a fixed membership listing with current row
state, not a historical permission snapshot.

Each page contains only new `records` and, for automation, new `jobs`. Coverage
`returned` counts are cumulative through that page. Run and job collections page
independently at the same offset, so continuation may return jobs with no runs or
runs with no jobs. Consumers append each collection separately. Exhaustion of one
collection does not exhaust the other. Never infer an empty result from a failed
page, silently restart an expired cursor or combine different first-page reads.

`INVALID_OPERATIONS_CURSOR` returns 400; `OPERATIONS_CURSOR_EXPIRED` returns 409.
Restarting after expiry requires a fresh first page and replacement of all prior
pages. Authentication loss clears protected cached data. Read responses retain
`Cache-Control: no-store` and expose aliases rather than private provider locators.

## Versioned schedule configuration

Saved job definitions carry an opaque `scheduleRef` for navigation. The schedule
detail read uses `viewKey: "scheduleDetail"`, exact `filters: { jobId: scheduleRef }`,
`period: null`, `sort: []` and no cursor. An unknown reference is not a fabricated
job. The native result is distinguished from demo data by
`kind: "saved-schedule-draft"`.

Reviewers save through `POST /v1/save` using `resourceKind: "configurationDraft"`,
`resourceRef: "schedule-" + scheduleRef`, the observed `expectedVersion`, a stable
`idempotencyKey` and a typed schedule draft. Readers can inspect configuration but
cannot save. Cookie writes require the existing same-origin and CSRF checks;
machine requests use the existing server-only bearer authorization.

Only a persisted response acknowledges a save. Version conflicts preserve the
unsaved form and require an explicit reconciliation with the current version.
The editor also verifies the acknowledged resource, exact canonical draft,
revision increment (or explicit no-change receipt), writer and finite save time.
An uncertain or mismatched acknowledgment preserves edits and requires a fresh
saved-draft read before the user can adopt it or rebase another save.
Cadence, local time and supported timezones are validated server-side. A derived
next-run preview describes what the configuration would mean if enabled; it is
not a trigger, run receipt, delivery promise or activation grant. Saving changes
neither the registered job's enabled flag nor its execution authorization.

Draft fields are `cadence` (`weekdays`, `daily`, `weekly-monday`), `localTime`
(`HH:MM`), `timezone` (`America/Los_Angeles`, `America/New_York`, `UTC`) and
`activeCohortOverride` (a requested configuration flag, not an approved override).
A skipped wall-clock time advances to the first valid minute after the gap; a
repeated time uses its first occurrence only. Versions bind both the registered
job version and draft revision, so a job definition change invalidates old edits.

The existing deployment and secret configuration are unchanged. Provider
activation and real scheduler registration retain their separate acceptance gates.
