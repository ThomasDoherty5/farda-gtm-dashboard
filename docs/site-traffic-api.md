# Shopify aggregate traffic

The native `customerJourney` view composes stored Shopify Analytics daily aggregates with source-owned storefront-order and creator-click readers. It uses no GA4 fallback and stores no customer or event identities. The default service has no provider binding: account, calendar, counters and the first actual import remain visibly pending.

## Trusted import boundary

Server composition accepts `siteTraffic: {source, orders, clicks, machine}`. These are qualified server-side owners, not callbacks, grants or count payloads supplied by a browser. `POST /v1/site-traffic/import` requires a distinct machine credential and a current proof bound to the exact scope, machine principal/grant, input hash and lease. Reader/reviewer sessions cannot import. The existing shared admission ledger applies; final caller/source checks occur inside the aggregate transaction and again before HTTP publication.

The strict command has `schemaVersion: "farda.site-traffic-import.v1"`, an exact sandbox `requestedScope`, and `input: {importRef, requestKey, expectedDefinitionVersion}`. References are opaque. The source owner retrieves a bounded `shopify-traffic-normalized.v1` JSON report through `readReport`; callers cannot post arbitrary counts or source permission flags. This is a normalized aggregate format for a qualified API/report adapter, not a claim that arbitrary Shopify CSV files are accepted. No provider credential, install, scheduler or export connection is supplied by default.

The report definition records the qualified account, report/version, calendar/timezone, bot filter, measurement/version, additive daily semantics, exact counter IDs/units and privacy-safe segment taxonomy. Source owners must qualify daily aggregation, including the provider's session-measurement version; a browser cannot assume calendar-day counts are additive. UTC boundaries must match the declared source calendar, including 23/25-hour days. Unsupported access remains explicit. The parser rejects raw identifiers, arbitrary UTM text, duplicate dimensions, invalid calendars and oversized reports before persistence.

## Storage and recovery

One stable definition/day/segment record holds the current count. Immutable source revisions and original import receipts preserve audit and replay. An identical report or revision cannot add sessions twice; a changed revision replaces counts atomically. Same-version/different-content, older revisions and reused original request keys are rejected. Partial updates do not advance omitted segment coverage or clocks. Only an explicit complete segment replacement establishes an omitted segment's zero population.

Retry the original request key and input after a lost acknowledgment. A currently authorized original-receipt lookup precedes a fresh report read; it does not silently rebase to new material. A refusal or missing HTTP acknowledgment does not establish that an earlier import was absent. Publication checks can reject a now-stale acknowledgment even after a commit; recovery still uses the original key. This writes local aggregates only and authorizes no provider effect.

## Read and metric semantics

`customerJourney` accepts `{period: null | {startDay, endDayExclusive, timezone}, segment: {kind: "all"} | {kind: "utm", segmentRef}}`. Null means the source-qualified current window, never the machine's timezone. Exact requested calendar and approved opaque segment must match the source. The outer adapter period/sort/cursor are not alternative traffic filters. All reads are authenticated and scope-bound; current owner, permission and source assertions run before publication. Browser cache keys include the complete scope and filters, and 401/403 clear protected data.

- Store conversion: matching Shopify storefront-origin orders / sessions. The fictional 260 / 16,000 fixture yields **1.625%**; global 400 orders and TikTok-owned Shopify mirrors are excluded.
- Add-to-cart: `sessions_with_cart_additions / sessions`.
- Checkout completion: `sessions_that_completed_checkout / sessions_that_reached_checkout`.
- Provider session conversion is separately labeled; completed/converted sessions are not the order count.
- Repeated product-view/cart events remain different measures and are never used as unique-session denominators or a forced descending funnel.
- Creator clicks and sessions retain distinct source/window labels. No blocked/missing UTM or individual-customer attribution is inferred.

Zero denominator gives N/A, not zero conversion. Missing/incompatible data is unknown. Coherent partial comparisons are provisional and disclose `observedThrough`. Source-as-of and import clocks are separate. Stale publication leases or failed refreshes retain explicitly historical counts while withholding conversion/attribution; a new valid source read is required for current figures.

`imports.firstActualImport` is independent of schema and fixture readiness. Only a validated nonsynthetic source receipt can establish it. Application fixtures remain labeled synthetic and never establish a native Shopify import. Actual source access and the first validated import stay pending until qualified evidence exists.

Primary definition references: [Shopify sessions schema](https://shopify.dev/docs/api/shopifyql/latest/schemas/sessions_and_behavior/sessions), [ShopifyQL Admin API](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api), and [Shopify's session measurement update](https://help.shopify.com/en/manual/reports-and-analytics/discrepancies/session-measurement-update).

## Verification

The service/boundary suites cover exact 1.625% math, independent session rates, duplicate/revised imports, partial omissions, zero/missing data, DST boundaries, privacy, original-key recovery and final permission/source fences. Actual HTTP tests exercise the machine endpoint and the same server SQLite database. Native browser journeys cover scoped filters/deep links, protected-data clearing, expiry/conflict retention, responsive source-layout adaptation, keyboard focus and actual Orca speech/audio. Heavy verification runs in cloud CI; fictional evidence is not production qualification.
