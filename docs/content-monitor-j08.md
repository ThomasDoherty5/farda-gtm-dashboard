# J08 hourly content and Inbox monitoring

J08 reads the enrolled creator watchlist every hour. For each eligible profile it reads the linked Instagram or TikTok posts and the native Inbox. It records deduplicated observations, coverage and freshness, and proposes follow-ups. It never sends, likes, follows, accepts terms, changes rates or approves samples.

**Stage: fixture-complete.** Every run described here uses synthetic data in a sandbox. No provider was contacted and no live hourly schedule was activated.

## How it is wired

| Concern | Owner |
| -- | -- |
| Cadence, window identity, account lease, checkpoint, retries, idempotency, run and item correlation | Existing `JobRuntime` (`src/creator-agent/jobs/runtime.ts`) |
| Membership, identity, suppression, Notion and Sheets enrollment receipts | J01 intake (`IntakeRepository.monitorMembership`) |
| Retained orders, refunds and canonical order identity | Funnel order ledger (`FunnelRepository`, `projectFunnel`) |
| Source capability and route denial | Capability ledger and J14 provider health |
| Monitor screens and aliasing | Existing monitor reader (`src/creator-agent/monitor/reader.ts`) |
| J08 executor, observations, coverage, incidents and proposals | `src/creator-agent/contentMonitor/` |

`bindContentMonitor` (`contentMonitor/runtime.ts`) follows the same pattern as the mirror reconciliation binding. It accepts only a registration that:

- belongs to the `J08` family;
- has an hourly cadence and enrolled-only membership (both already required by `runtimeSchema.ts`);
- runs in observe mode on an API route, with no model channel and no browser fallback;
- holds a single account lease (`maxConcurrency: 1`);
- pins the same policy version as the J08 policy;
- has an executor reference that nothing else uses.

It adds the J08 executor to the runtime registry.

`createAgentServer` composes it from the `contentMonitor` option. The option takes:

- the registration reference;
- a reader for the current versioned policy;
- the read-only J08 source;
- the evidence stage (`synthetic` or `source`).

The composed binding becomes the monitor reader's source, so the four monitor routes serve the J08 store. A server cannot set both `contentMonitor` and `monitorSource`.

`/v1/capabilities` reports `contentMonitor.sourceExecution` as follows:

- `sandbox` for synthetic evidence;
- `registered-runtime` for source evidence;
- `notConnected` when J08 is not bound.

It never reports `connected` for synthetic evidence.

### Triggers

A run starts through the existing runtime machine route (`POST /v1/runtime/machine`), in one of three ways:

- **Hourly:** `fire` with the hourly slot.
- **Manual recheck:** `fire` for the same slot with a different trigger reference. It reuses that window's frozen snapshot and run.
- **Missed hours:** `catchUp` admits them.

Activation stays with the runtime authority. J08 does not enable a schedule.

The runtime authority builds each window plan from `plan()`. That function freezes one finite page of the eligible J01 watchlist per window. A refresh of the same window returns the same frozen rows. A later membership change acts on the next item, not on the frozen snapshot.

## Each item

One runtime item is one enrolled profile. Each step reads one bounded page. The posts stage runs first, then the Inbox stage. Each page becomes a runtime checkpoint, and the per-source cursor is stored by J08.

Before any source call, the executor holds the item, with no read, if:

- the current J08 policy version differs from the registration (`J08_POLICY_VERSION_CHANGED`);
- the creator is no longer active, unsuppressed and enrolled in J01 (`J08_ENROLLMENT_CHANGED`).

The runtime's existing activation fence stops work when a schedule is disabled.

A page is validated server-side. It is rejected before any write if:

- its request digest does not match;
- its evidence stage does not match the binding, so a synthetic page cannot enter a source binding;
- it carries records from another account;
- it exceeds the record bound;
- it carries both posts and Inbox records for the wrong stage;
- its source observation time is outside the runtime's 15-minute source lease.

The same checks run again inside the store transaction, together with the source's own synchronous fence. A source receipt reused with different facts is refused.

Access failures map as follows. Each preserves the checkpoint and the last confirmed observations.

| Source access | Runtime step | Coverage | Recovery owner |
| -- | -- | -- | -- |
| throttled, unavailable | retry with Retry-After | deferred, then failed when attempts run out | runtime retry, then J14 |
| denied | held | inaccessible | J14 |
| login, MFA, captcha, terms change | owned takeover | inaccessible | J14 |
| UI drift | owned takeover | failed | J14 |

## Outputs

`output(runRef)` returns the typed outputs:

- `contentRefs`;
- `metricSnapshots`;
- `statusObservations`;
- `freshnessCoverage`;
- `nextActionQueue`;
- `checkpoint`.

It also returns `originals`, the number of distinct creatives. `trace(runRef, key)` returns the same data with keyed aliases only. It is safe to retain as evidence.

### Coverage

Every frozen row ends in exactly one category. The runtime item state decides whether a row is terminal; J08 supplies its content meaning.

- **newContent:** read completely, with new content or a new Inbox event. This includes posts that wait for attribution review.
- **unchanged:** read completely, with no new content or Inbox event. Counter changes are recorded as metric snapshots, not as new content.
- **inaccessible:** the source denied access or needs a login, MFA, captcha or terms takeover.
- **failed:** the read failed, ran out of attempts or hit UI drift.
- **deferred:** due but not visited or not finished: queued, retrying, or held for policy or eligibility.

The five categories add up to `snapshotCount`. `scanned` is the subtotal of completely read rows (`unchanged + newContent`).

Two claims are `null` unless the run is complete:

- `noNewContent`;
- `allClear` (no open incident at the end of that run).

A run is complete only when every row was read completely and its window was planned in one complete page.

### Freshness

Each source page carries its own observation time. A status change uses the post's `sourceUpdatedAt` when the source gives one. These source watermarks drive:

- the row's `at`;
- the separate `lastSuccessAt` (last complete, healthy read);
- the run-level `lastSourceSuccess`;
- the projected snapshot time.

The agent's poll time and any mirror sync time are never used. The store-backed packet expires at the existing 90-minute monitor ceiling, measured from the newest source watermark. A later, unvisited planned window, or an incomplete latest run, makes the read partial.

### Identity and deduplication

- **Content:** identity is the native network, account and post ID. A changed URL, creative or evidence updates the same content.
- **Inbox:** messages are keyed by network, account and message ID.
- **Unchanged counters:** they only advance `confirmedThrough`. They create no new snapshot, delta, lifecycle event or proposal.
- **Status:** a lifecycle row is written only when the confirmed state or access changes, and never from an older watermark.
- **Crossposts:** each keeps its own native identity and links to one creative. The first observed post of a creative is the original; `originals` counts creatives, not posts.

### Farda attribution and orders

A post counts as Farda campaign content only when reviewed evidence names exactly one campaign the creator is enrolled in. That evidence is a product link, discount code, reviewed link or collaboration evidence with a campaign.

These cases stay in review, with a J09 proposal, and never enter Farda activity metrics:

- unreviewed evidence;
- brand-only evidence;
- several named campaigns;
- a campaign the creator is not enrolled in.

A post with no Farda evidence is unrelated. It is never filtered by engagement.

Order attribution reads the funnel order ledger at the best proven level:

- **Post level:** orders that carry the post ID.
- **Creator level:** a creator-wide code without a post. It is never allocated to a post.
- **Unknown:** no order evidence, conflicting post assignments, or a mixed window, version or currency.

The ledger keys orders by canonical order ID, so a TikTok Shop order imported into Shopify counts once. A missing metric is stored as `null` with its source reason. Engagement rate and view totals stay unknown when shares are missing or view definitions differ, for example between Instagram and TikTok.

### Incidents and proposals

An inaccessible row or post opens an incident owned by J14. Only a later complete, healthy observation with a newer source watermark closes it. Unbinding, suppression, removal or a new registration version never closes it.

Proposals are J08 outputs with an owner, and they are never dispatched:

| Trigger | Owner |
| -- | -- |
| Inbox reply | J09 |
| Confirmed private, deleted or expired post | J09 |
| Attribution review | J09 |
| Owner conflict | J09 |
| Source access failure | J14 |

Each condition has one stable key, so a repeat does not duplicate it. J08 creates no approval, dispatch or action-domain record.

## Policy

`j08PolicySchema` requires an explicit policy version, a checkpoint version with strictly increasing hours, and the attribution rule version. There are no code defaults.

The sandbox carries the ticket's initial implementation defaults (24h, 7d, 30d) as `ticket-initial-checkpoints-v1`. An observation captures only the highest checkpoint it has reached above those already captured, and records its actual age. A later fetch never fills an earlier checkpoint. The post page labels it, for example "24h checkpoint, observed at actual age 26.1h".

## J08-10 sandbox

`src/creator-agent/contentMonitor/sandbox.testkit.ts` holds fictional creators, posts, messages and orders. The sandbox runs them through:

- the actual HTTP service and SQLite file;
- J01 intake;
- the funnel order ledger;
- the registered runtime.

It covers:

- Instagram and TikTok profiles, including a crosspost of one creative;
- an Inbox reply;
- zero-engagement content;
- a TikTok order also imported into Shopify;
- a creator-wide code;
- brand-only evidence for a creator in two campaigns;
- an unrelated post;
- a paginated TikTok profile whose second page fails once;
- a later hour with unchanged counters, a post that turned private and a login-required row.

Testkit files are excluded from the production image (`.dockerignore`). The production launcher binds no J08 source, and a source-stage binding refuses synthetic pages.

- `src/creator-agent/contentMonitor.integration.test.ts` covers J08-01, J08-02, J08-03, J08-07, J08-09 and J08-10, incident clearing, read-only behaviour, validation, aliasing, composition and the environment guard.
- `src/creator-agent/contentMonitor/rules.test.ts` covers attribution, checkpoints, unknown versus zero and order levels.
- `e2e-agent/monitor-evidence.spec.ts` ("J08 sandbox run…") drives the same sandbox through the browser. It writes `j08-sandbox-run.json` (four-metric output and redacted traces) and desktop and mobile captures of the changed run and post views.

## Not yet proven

These need a native sandbox or a live source run. None is claimed here.

- A qualified J08 source adapter for Instagram, TikTok and Inbox (API, insight export or authorized browser), with real account permissions, scopes, pagination and rate limits.
- A source-owned runtime authority that freezes `plan()` windows, issues quota grants and activation, and resolves takeovers.
- Live hourly activation in the configured timezone, and any browser fallback route with its own selectors.
- The order sync owners (TikTok Shop and Shopify) feeding the funnel ledger with real canonical order IDs.
- A J09 owner that consumes the proposals. J08 only records them.
- No-post detection, which needs the collaboration posting clock.
- Agreed campaign duration as a limit on checkpoints. The source does not supply it yet.
