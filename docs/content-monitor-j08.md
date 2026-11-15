# J08 hourly content and Inbox monitoring

J08 reads the enrolled creator watchlist every hour. For each eligible profile it reads the linked Instagram or TikTok posts and the native Inbox. It records deduplicated observations, coverage and freshness, and records follow-up proposals. It never sends, likes, follows, accepts terms, changes rates or approves samples.

**Stage: fixture-complete.** Every run described here uses synthetic data in a sandbox. No provider was contacted and no live hourly schedule was activated.

## Who owns what

| Concern | Owner | J08's part |
| -- | -- | -- |
| Cadence, windows, pages, runs, items, leases, checkpoints (including the source cursor), takeovers, retries, idempotency | Existing `JobRuntime` | None. J08 reads them through read-only accessors (`windowPages`, `takeovers`). |
| Membership, identity, suppression, Notion and Sheets enrollment receipts | J01 intake | Eligibility is evaluated on every item; the creator ID is always resolved live. |
| Source health and capability | J14 provider health and the capability ledger | J08 routes source-access failures to J14 and reads its exceptions. J14's own health hold gates the binding. |
| Retained orders, refunds, canonical order identity | Funnel order ledger | J08 joins it read-only for post and creator attribution. |
| Observed post lifecycle, native metrics, checkpoints, Inbox receipts | **J08** | Stored in `content_monitor_*` tables. |
| Frozen watchlist for each window | **J08** | One row per window. It is the typed `watchlistVersion` input. |
| Follow-up proposals | **J08**, as immutable per-window output | No J09 owner exists on main, so nothing routes or dispatches them. |
| Shared reporting delivery | Existing slackReporting reporter | J08 supplies a typed `ReportEvent`; delivery keeps the reporter's policy. |

### Post lifecycle: one publisher

The monitor reader used to merge funnel `published`/`removed`/`postMetrics` events into the same posts as a trusted source snapshot, so a post's lifecycle had two publishers. Now the trusted monitoring source (J08) owns the lifecycle and metrics of every post it observes.

The funnel ledger still owns orders and refunds, and a saved ledger event still marks a post as conflicting when its creator or campaign disagrees. Funnel publication events still create posts that J08 has not observed.

J08 was chosen as the owner because it reads native posts and authorized insight exports. The funnel's generic `postMetrics` carries only a total view count, with no component breakdown or metric basis.

## How it is wired

`createAgentServer` composes J08 from the `contentMonitor` option. The option takes:

- the hourly registration;
- an optional manual-recheck registration;
- a reader for the current versioned policy;
- the read-only J08 source;
- the evidence stage (`synthetic` or `source`).

`bindContentMonitor` (`src/creator-agent/contentMonitor/runtime.ts`) follows the mirror reconciliation binding. It accepts an hourly registration only if it:

- belongs to the J08 family, with an hourly cadence and enrolled-only membership;
- runs in observe mode on an API route, with no model channel and no browser fallback;
- holds a single account lease (`maxConcurrency: 1`).

It pins the policy digest and requires an approved policy for a source-stage binding. It then adds the J08 executor to the runtime registry.

The server wraps the injected runtime authority with `composeAuthority`. For a J08 window it passes J08's frozen watchlist page as `membership`, so the source authority signs its lease over exactly those items. An authority that returns any other membership is refused (`J08_WINDOW_PLAN_MISMATCH`) before admission. No test holder or caller-side wiring is involved.

The monitor reader's source is the binding's store-backed `MonitorSourceReader`. A server cannot set both `contentMonitor` and `monitorSource`.

`/v1/capabilities` reports:

- `sourceExecution`: `sandbox` for synthetic evidence, `registered-runtime` for source evidence;
- `followUpProposals: recorded-run-output-no-owner`;
- `sourceHealth: routed-to-j14`.

It never reports `connected` for synthetic evidence.

### Triggers

- **Hourly:** a runtime `fire` for the slot. A duplicate trigger for the same slot reuses the same frozen window and run.
- **Bounded manual recheck:** a `fire` on the manual-recheck registration. That registration has an event cadence (`j08-manual-recheck.v1`) and must share the same source binding and policy version. Each recheck event is its own window, so it re-reads, bounded by the registration's budgets. It shares the account lease with the hourly window.
- **Incremental source events:** not supported.

Activation stays with the runtime authority; J08 does not enable a schedule.

### Windows and pages

The whole eligible watchlist is frozen once, at the first admission of a window. It records the eligibility policy version and each row's J01 enrollment reference. Every page, and every refresh of a page, is a slice of that snapshot.

The runtime caps a page at the registration's `maxItems`, at most 100. Further pages are admitted with the runtime's `continue` once the prior page completes. Coverage is computed for the whole window across all its pages: frozen rows on pages not yet admitted are deferred.

## Each item

One runtime item is one enrolled native profile. Rows are keyed by profile, so a changed J01 creator ID follows the profile. The posts stage runs first, then the Inbox stage. Each page becomes a runtime checkpoint, and the source cursor (at most 170 bytes) is encoded inside it. There is no second cursor store.

The executor holds the row without reading the source when:

- the current policy digest differs from the pinned one;
- the row is no longer eligible in J01;
- the row already failed with a non-transient denial in this run and no takeover has been resolved;
- a takeover on the same source binding is still open.

The runtime's activation fence stops work when a schedule is disabled.

A page is validated server-side and rejected before any write if:

- its request digest does not match;
- its evidence stage does not match the binding;
- it carries records from another account;
- it exceeds the record bound;
- it carries records for the wrong stage;
- its source observation time is outside the runtime's 15-minute source lease.

The same checks and the source's own fence run again inside the store transaction. A reused receipt with different facts is refused, and a source error with status 401 or 403 is a denial, not a retry.

| Source access | Runtime step | Coverage | Owner |
| -- | -- | -- | -- |
| throttled, unavailable | retry with Retry-After | deferred, then failed when attempts run out | runtime retry |
| denied (row level) | held, not re-read in this run | inaccessible | J14 is asked to observe the source |
| login, MFA, captcha, terms change (source session) | one owned takeover; the account's other rows are held unread | inaccessible | takeover owner and J14 |
| UI drift | owned takeover | failed | takeover owner and J14 |

J14 routing runs after the runtime has committed the row's hold or takeover. It is deduplicated per window and condition. When J14 observes the session as unhealthy, its existing health hold stops the binding for every row, so one login wall gives one takeover and one J14 observation.

J08 never clears J14 or a takeover itself. The session must recover, J14 must observe it again, and the takeover owner must resolve the takeover with a source receipt. After a complete, healthy read, J08 asks J14 to re-observe any exception that is still open.

## Outputs

`output(windowRef)` returns the typed outputs:

- `watchlistVersion`;
- `contentRefs`;
- `metricSnapshots`;
- `statusObservations`, with the page's method and the post's own `sourceUpdatedAt`;
- `freshnessCoverage`;
- `nextActionQueue`, where each entry carries its Ref;
- `checkpoint`.

It also returns `creatives` and `provenance`.

`trace(windowRef, key)` is the same data with keyed aliases only. `report(windowRef, binding)` returns a typed orange `ReportEvent` for the shared reporter when a window has inaccessible, failed or deferred rows or new proposals, and `null` otherwise.

### Coverage

Every frozen row ends in exactly one category:

- **newContent:** read completely, with content or an Inbox event first observed after the row's previous complete success. Content first seen during a failed run therefore counts on the next complete read.
- **unchanged:** read completely, with nothing first observed since the row's previous complete success. Counter changes are metric snapshots, not new content.
- **inaccessible:** a row-level denial or a source-session takeover.
- **failed:** the read failed, ran out of attempts or hit UI drift.
- **deferred:** due but not finished: queued, retrying, held for policy or eligibility, or on a page not yet admitted.

The five categories add up to `snapshotCount`, and `scanned` is the completely read subtotal.

`lastSourceSuccess` is the **oldest** per-row last success, so one stale row cannot be hidden. It is null if any row has never succeeded, and per-row values are in `rows`.

`noNewContent` and `allClear` are `null` unless the window is complete. `allClear` counts every open condition: row failures (including rows that have left the watchlist), open takeovers, and open J14 exceptions. Row conditions are evaluated as of the window's own last source observation.

### Freshness and lifecycle

Every lifecycle row and metric snapshot is ordered by the page's source observation time. A post's `sourceUpdatedAt` is kept as data only, so an old edit time cannot keep a post inaccessible. The agent's poll time and any mirror sync time are never used.

A row-level failure stands until a later complete, healthy read of the same row. Unbinding, suppression, removal or reconfiguration never clears it.

The projected packet expires at the existing 90-minute monitor ceiling, measured from the newest source watermark.

### Identity and deduplication

- **Content:** identity is the native network, account and post ID. Only a newer page updates mutable facts such as URL, creative or evidence; an older page inside the lease changes nothing.
- **Unchanged counters:** they only advance `confirmedThrough`. They create no snapshot, delta, lifecycle row or proposal.
- **Crossposts:** each keeps its own native identity. A crosspost is an original or a derivative only when a reviewed creative mapping says so; otherwise it is unmapped. `creatives.originals` counts originals by creative.
- **Deliverable and collaboration:** a deliverable comes from the reviewed creative mapping. A collaboration stays explicitly unknown (`J01_COLLABORATION_NOT_LINKED`).

### Farda attribution and orders

A post counts as Farda content only when reviewed evidence names exactly one campaign the creator is enrolled in.

These cases stay in review, with a recorded J09 proposal, and never enter Farda activity metrics:

- unreviewed evidence;
- brand-only evidence;
- several named campaigns;
- a campaign the creator is not enrolled in.

A post with no Farda evidence is unrelated. Posts are never filtered by engagement.

Order attribution reads the funnel ledger:

- **One order:** orders are keyed by canonical order ID, so a TikTok Shop order imported into Shopify is one order.
- **Refunds:** a refund without a post ID inherits its order's single post assignment. Only differing explicit post IDs conflict. The monitor reader's reconciled totals apply the same rule.
- **Creator level:** an order with no post assignment is creator-wide and is never allocated to a post.
- **Post level, including zero:** reported only once the post's own attribution window has matured (from the policy's `attributionWindows` for that attribution version) and the cohort's evidence is complete. Absence of orders alone is unknown, never zero.

A missing metric is `null` with its source reason. Engagement rate and totals stay unknown when shares are missing or view definitions differ, for example between Instagram and TikTok.

### Proposals

These conditions are recorded once, as immutable per-window output owned by J09, with no lifecycle:

- an Inbox reply;
- a confirmed private, deleted or expired post;
- an attribution review;
- an owner conflict.

Source-access conditions belong to J14 and the runtime takeover. J08 writes no approval, dispatch, action or incident record.

## Policy

`j08PolicySchema` has no code defaults. It requires:

- the version;
- an approval state, `approved` with a reference or `unapprovedFixture`;
- the eligibility policy version;
- the checkpoint version, with each slot's hours and tolerance;
- the attribution maturity window per attribution version;
- the attribution rule version.

The binding pins the policy's digest. Any change holds the next item. A new window needs the pinned policy. A source-stage binding refuses an unapproved policy.

A checkpoint is captured only inside its tolerance. A fetch after the tolerance is a **late observation**: it is labeled with its actual age, fills nothing, and the post card never shows it as a checkpoint.

The sandbox policy is `unapprovedFixture`. It carries:

- the ticket's initial checkpoints (24h, 7d, 30d);
- synthetic tolerances of 2h, 12h and 24h;
- a synthetic 168-hour attribution window.

## J08-10 sandbox

`src/creator-agent/contentMonitor/sandbox.testkit.ts` holds fictional creators, posts, messages and orders, a synthetic J14 target and the manual-recheck registration. The integration test and the agent browser journey drive them through:

- the actual HTTP service and SQLite file;
- J01 intake;
- the funnel order ledger;
- J14 provider health;
- the registered runtime.

Testkit files are excluded from the production image (`.dockerignore`). The production launcher binds no J08 source, and a source-stage binding refuses synthetic pages and unapproved policies.

- `src/creator-agent/contentMonitor.integration.test.ts`: J08-01, -02, -03, -07, -09 and -10, plus the plan composition, multi-page windows, row and source-session failures, lifecycle ordering, new-content rules, validation, read-only behaviour, the report, the environment guard and composition errors.
- `src/creator-agent/contentMonitor/rules.test.ts`: attribution, checkpoint tolerance, order level, maturity and refund inheritance.
- `src/creator-agent/monitor/reader.test.ts`: source-owned lifecycle and refund inheritance in reconciled totals.
- `e2e-agent/monitor-evidence.spec.ts` ("J08 sandbox run…"): writes `j08-sandbox-run.json` (four-metric output and redacted traces) and desktop and mobile captures.

## Not yet proven

These need a native sandbox or a live source run. None is claimed here.

- A qualified Instagram/TikTok/Inbox source adapter, with real permissions, scopes, pagination, cursors within the checkpoint bound, and rate limits.
- A source-owned runtime authority that signs leases over the composed membership, issues quota and activation, and resolves takeovers.
- A qualified J14 target and probe for the J08 source account.
- Live hourly activation in the configured timezone, and any browser fallback route.
- The order sync owners (TikTok Shop and Shopify) feeding real canonical order IDs and refunds.
- A J09 owner that consumes the recorded proposals.
- No-post detection, which needs the collaboration posting clock.
- Agreed campaign duration as a limit on checkpoints.
- Incremental source events.

## Owner decisions still open

- **Checkpoint tolerances:** the production values for 24h, 7d and 30d.
- **Attribution windows:** the production maturity window for each attribution version.
- **Brand-only evidence:** whether reviewed brand evidence for a creator with exactly one active campaign may attribute. It stays in review today.
- **Policy approval:** the approval reference for a production J08 policy.
