# Read-only monitoring views

The four monitor screens read the authenticated adapter and retain the existing demo routes as explicit fixtures. Native reads combine the scoped intake membership projection, verified saved publication receipts and an optional trusted server-only monitoring snapshot.

| Route | Component | Typed read |
| --- | --- | --- |
| `/content` | `NativeContentMonitor` | `contentMonitor` |
| `/creators/watchlist` | `NativeWatchlistPage` | `watchlist` |
| `/runs/:runId` | `NativeHourlyPage` | `hourlyRun` |
| `/content/:postId` | `NativePostBody` | `postPerformance` |

`src/creator-agent/monitor/contract.ts` validates the source packet and all four native DTOs. `reader.ts` reads the existing scoped SQLite connection. `posts.ts` projects native publication and financial evidence. `NativeMonitorViews.tsx` uses the established protected read hooks, cards, tables, fields and navigation components.

## Source contract

The server option `monitorSource` accepts a `MonitorSourceReader`. Its input contains the exact workspace, account and sandbox environment. Its result contains a versioned finite snapshot with observation time, expiry, coverage, canonical membership references, native post identities and run evidence. A source implementation must verify these facts through its existing authorized source connections before returning them. The launcher currently supplies no live J08 source.

The snapshot reader has no browser ingestion endpoint. Configuration, scheduling, identity resolution, source sessions, replies and other provider actions retain their existing owners. The displayed retry capability stays held until an exact J08 authority is available.

Membership joins use creator revision, network, publishing account and native profile ID. Active monitoring requires current canonical identity, an open relationship, current suppression eligibility, complete coverage and matching Notion-to-Sheets evidence. The trusted source owner may supply an independent scoped J01 receipt set. Duplicate owners, unmatched rows, stale receipts and missing identity remain visible for reconciliation.

Optional bounded review evidence uses that same exact creator/revision/profile/account join. It carries original intake evidence and decision receipts, competing identity claims, and dated exclusion reasons/owners. A missing or mismatched source cannot manufacture history from a last-check time. The pending-review navigation count describes its actual source/cohort destination independently of the currently selected monitoring state. History dialogs explicitly describe the loaded page rather than claiming an unbounded archive.

Observed message context carries the exact network/account, conversation/message references, source version and observation time. Status suggestions retain the status at observation, proposed value and expected version. All raw identity, owner and receipt references are projected to scoped aliases; message bodies, source URLs and credentials are excluded. Repeated identical events deduplicate by network/account/native-event identity; contradictory duplicates fail validation. Review dialogs permit no outbound message, identity merge, enrollment, exclusion removal or source-status write. Schedule configuration remains held when its exact authorized configuration reference is unavailable.

## Metrics and history

Every confirmed campaign publication remains eligible for display, including zero and low engagement. Publication identity uses network, publishing account and native post ID. Recruitment source is a separate field. Native publication, visibility history, campaign assignment, creative/deliverable lineage, attribution level, publication-age checkpoint and original receipt references remain inspectable.

Search also matches a known handle only when the post's canonical creator, network and account resolve to exactly one active, permitted profile. It never guesses among multiple profiles or borrows a handle for a conflicted post; unavailable or quarantined identity retains unknown coverage. Source/network filters still apply to the matched posts.

The view total requires comparable metric definitions, windows, counter basis and organic/paid context. Its DTO retains that exact basis beside the neutral Observed views label. Missing components remain unknown. Same-instant contradictory measurements are quarantined even when their timestamps use different offsets. Counter corrections retain their signed change.

Post-level outcomes require an explicit post attribution claim. Creator- or campaign-level outcomes appear separately. Multi-post sales totals require matching verified order receipts, exact attribution window/version and currency, then reuse the existing funnel projection for order/refund deduplication. Ambiguous assignments remain unknown. Signed money accumulation uses exact integers before safe-number bounds checks. TikTok GMV retains its own definition.

## Protected reads and recovery

Continuation tokens bind scope, role, view, filters, page size, frozen read time, source facts and the saved-event watermark. They use the private operations key and expire within fifteen minutes. A renewal of the same source facts can preserve an existing list while keeping its original observation time and expiry. Material source or membership changes require a list restart.

Page counts describe the returned page. A final page remains partial when it represents only part of the finite universe. Empty results expose the saved count and keep provider-wide coverage unknown. Expired source evidence is labeled. Permission failures clear protected client data through the shared adapter hooks.

The source lease cannot exceed the server's ninety-minute monitoring age ceiling, even if the supplied expiry is longer. It is checked after awaited reads and bounds continuation expiry. Review/message detail observations have their own ninety-minute ceiling; refreshing an outer snapshot does not refresh older detail. Denied or expired details are withheld, while known ambiguous claims retain their identity-review hold. Changes to source facts or detail expiry invalidate continuation. Open dialogs retain selection keys, not private copied rows, so revalidation removes revoked details.

Native screens use tables for sparse source measurements. The original fixture charts remain in the explicitly labeled demo route. This prevents a missing timeseries from becoming a fabricated curve. Long evidence references wrap within horizontally scrollable, labeled table regions on narrow screens.

## Verification

- `src/creator-agent/monitor/reader.test.ts` covers identity ambiguity, suppression, source expiry, cursor binding/renewal, checked/failed distinctions, native publication provenance, financial reconciliation, first-observed removal, timestamp conflicts and exact signed accumulation.
- `src/features/monitor/monitor.test.tsx`, `postEvidence.test.tsx` and `src/adapter/viewSchemas/monitor.test.ts` preserve the existing typed fixture and interaction coverage.
- `e2e-agent/monitor-evidence.spec.ts` uses the actual local HTTP service and SQLite with fictional server-owned J01/J08 authorities. It covers all four screens, desktop/mobile accessibility, source failure/recovery, identity receipt joins and distinct post/creator attribution.
- The same native journey exercises read-only identity, intake-history, message and status-suggestion dialogs, denied detail, real Escape/focus return, and desktop/mobile captures of both ends of scrollable dialogs. `nativeMonitor.test.tsx` separately verifies scoped adapter reads and removal of denied details. Isolated Linux CI uses actual Orca/AT-SPI speech and recorded audio; a jsdom dialog shim is never counted as native keyboard or screen-reader proof.

The verified software stage is sandbox integration. Live hourly monitoring depends on the source owner's authorized J08 implementation and current provider access.
