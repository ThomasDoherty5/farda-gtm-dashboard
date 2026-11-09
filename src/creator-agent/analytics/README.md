# Native dashboard reporting reads

The existing agent serves seven analytics families through authenticated `POST /v1/read`: `overviewSummary`, `attribution`, `paidMedia`, `launchSnapshot`, `launchReconciliation`, `campaignFunnel` and `metricDictionary`. `customerJourney` remains owned by the existing site-traffic ingestion service. This module does not fetch providers, dispatch work, send content, change budgets or create another business ledger.

`createNativeAnalyticsReader` accepts a server-injected `NativeAnalyticsSource`. The source returns a typed packet bound to the exact workspace/account/environment, authenticated principal and requested filters, reporting period and page. Every contributing owner carries source/permission/definition versions, cohort/window, observation time, source time, coverage and a short read-access lease. A synchronous `assertCurrent` is required after the bounded read and again at publication. The surrounding server independently rechecks the current caller. Missing owners, denied access, malformed packets and expired permission are typed failures, never demo fallback.

Public response schemas are in `views.ts`; source schemas are in `contract.ts`. Native payloads have `datasetKey: analytics-native` and explicit synthetic/source provenance. Source, account, creator, asset, evidence and version references are keyed aliases. Labels are finite categories or validated short asset codes. Credentials, customer identities and source error prose never enter the read payload. Aliased approval/run references are display references, not navigable canonical action identifiers.

## Requests and source behavior

All read envelopes use the shared schema and caller's exact requested scope. For example, the body below uses fictional identifiers:

```json
{
  "schemaVersion": "2026-11-02.proposed",
  "requestId": "fictional-report-read",
  "requestedScope": {"workspaceId":"fictional-workspace","accountIds":["fictional-account"],"environment":"sandbox"},
  "viewKey": "paidMedia",
  "filters": {"platform":"tiktok","rights":"notGranted"},
  "period": {"startAt":"2026-10-01T00:00:00Z","endAt":"2026-11-01T00:00:00Z","timezone":"UTC","basis":"eventTime"},
  "sort": [],
  "page": {"cursor":null,"limit":25}
}
```

A null period asks the source to select and prove its window. An explicit period must match the supplied source proof and complete source-calendar day boundaries, with an exclusive end. An unsupported or malformed period fails rather than silently using the default. Aggregate views reject cursors; paid assets are ranked by qualified CTR before paging, and signed cursors bind principal, filters, window, source, permission and definition versions. Source changes require starting a new read, never continuing an old page under a new meaning.

Campaign routes use an explicit source-owned campaign/cohort mapping or the matching canonical public pair. The browser preserves requested selectors. Complete total counts require an explicit `disjointComplete` source assertion about channel opportunity membership; an unknown partition keeps totals Unknown. Mature-posting rates require a separately qualified count of posts within the mature delivered group. All published posts cannot replace that subset.

## Result semantics

Known zero, Unknown and N/A are distinct. Facts include `state`, `value`, `reasonCodes`, `evidenceRefs`, `sourceAsOf`, `observedAt` and `provisional`. Measures attach numerator, denominator, unit and `headline-metrics.v1`. Missing inputs and unqualified ratios remain Unknown; a qualified zero denominator yields N/A. Retained stale nonzero observations can remain visibly provisional while their read permission is current; partial/stale zero does not establish a complete zero.

Money is integer USD minor units. Orders and native/mirror identities must reconcile. Platform purchase values never add to storefront orders. Paid spend includes GMV Max, while CTR/CPC/CPM/ROAS use matched standard campaigns and the qualified platform attribution window. Economics reuse the canonical allocation rules: linked cash and accrual observations do not double count one obligation; missing landed costs, immature retention and estimates remain qualified. Late refunds retain the original cohort revision.

The shared response envelope includes `dataVersion`, `dataState`, coverage, source freshness, page and refresh metadata. No configured source yields503 `ANALYTICS_SOURCE_UNCONFIGURED`, with no data. Source permission loss yields401/403; mismatched versions or expired access yield409. Error envelopes retain request/correlation and retry semantics without arbitrary source text. Cancellation aborts the bounded source operation. Protected browser bodies and dialogs clear after a failed native refresh or read-lease expiry.

The sibling sourcing reader preserves the existing immutable source-version tables and plan projection. It adds exact caller/source authority and a read lease, rather than creating a plan executor. The shipping hub similarly projects existing shipping, stock, terms and posting owners; labels, publication and financial actions remain separately gated. Legacy operations reads carry a separate `readAccess` deadline and never invent a named actor from a generic reader/reviewer role.

## Verification scope

Focused source/real-HTTP tests cover seven analytics schemas, source/current-caller races, partial versus zero, filtering, paging, stale observations and privacy. Browser journeys exercise source-backed synthetic layouts, controls, denial/expiry clearing, exact period navigation, accessible tables and real screen-reader checkpoints in cloud CI. These are implementation fixtures, not native provider qualification. Whole dashboard acceptance also requires the existing per-family read/save tests, exact-head CI, reviewed full-frame visual evidence and hosted release readback; no passing result is implied by this document.
