# Overview owner projections

The native overview composes existing attribution, Operations, Finance, content-monitor and stored portfolio readers. It does not create another ledger, scheduler or scoring service. Each read retains its principal, source revision, permission fence and effective freshness deadline. A mismatched cohort, reporting window, currency or evidence stage produces an unavailable summary; a permission loss or changed source invalidates the composed response.

| Route / original frame | Component | Owner and interaction |
| --- | --- | --- |
| `/overview` · `10:217` | `NativeOverview`, `OverviewOwnerSummaries` | Commerce chart plus canonical owner summaries; exact-period attribution, Operations, Finance, monitoring and shipping links; portfolio proposal dialog |
| `/launch?view=snapshot` · `3:6` | `NativeLaunchSnapshot`, `NativeReportSchedule` | Launch evidence and relative gates; read-only report configuration through the existing `operationsControl` reports view |
| `/launch?view=control` · `14:74` | `NativeLaunchControl`, `NativeLaunchDecision` | Permission-bound gate/task metadata, proposed-date handoff and the existing exact-version founder readiness command |
| `/analytics/attribution` · `14:377` | `NativeAttribution` | Existing attribution precedence and cost evidence; same creator-code order/net basis as overview |
| `/analytics/paid-media` · `30:349` | `NativePaidMedia` | Existing platform diagnostics and asset-rights evidence; media spend remains separate from creator sample costs |
| `/campaigns/:campaignId?tab=funnel` · `30:550` | `NativeCampaignFunnel` | Existing campaign progression plus cohort-bound reservation home/item/units/cost approval/provenance |
| `/analytics/customer-journey` · `30:721` | `NativeCustomerJourney` | Existing site-traffic owner; no aggregate-analytics substitution |

The original KPI/chart hierarchy, shared cards, dialogs, tables, Inter font and token styles remain the visual basis. Required owner summaries and report evidence extend the original full pages. Native sources replace illustrative data with qualified values, explicit missing values or holds; these are deliberate state adaptations, not a claim that source and demo pixels match. Private source captures and full-content comparisons stay outside this public repository.

## Reporting semantics

- Finance supplies an exact QuickBooks period, currency, accounting basis and adopted definition. The detail and overview reuse one accounting-owner projection for gross margin, cash, runway, actual revenue and forecasts. Proposed forecasts are labeled; missing forecasts remain N/A.
- Operations supplies the home and request/event window, latency denominator and sum of days, plus cost denominator and sum in minor units. Known averages must reconcile to that basis. A unified-hub link preserves all recipient/purpose scope and a qualified request-time window; an event-time-only view cannot silently substitute it.
- Monitor summaries select source-proven interval measurements and attribution for the exact campaign/window. A lifetime counter's observation date is not an interval. Network coverage and live-content membership remain visible.
- Portfolio summaries use the existing stored review and its versioned algorithm. Dimensions overlap; mature retained contribution and organic/paid evidence remain separate. Recommendations authorize no invitations or renewals.
- Source sync status distinguishes changed, unchanged, never-synced, partial, error and unknown coverage. A newly observed row cannot renew a failed dataset-wide check.
- Reservations are source reads, with counted coverage, aliased provenance and cost-approval evidence. They neither deplete stock nor confirm fulfillment. Partial evidence cannot assert current approval authority.

## Boundaries and verification

Source-owned task URLs are limited to canonical HTTPS Notion/Linear paths without embedded credentials or query tokens. Synthetic navigation stays disabled. Proposed dates require real calendar input, a rationale and current sample-acceptance evidence before the source-workflow handoff. The existing readiness command remains distinct from date approval, scheduling and release.

`overviewOwners.test.ts` exercises canonical owner composition, scope mismatch, incomplete denominators, stale/partial evidence, separate grants and revocation. `overview-owners.spec.ts` compares actual HTTP overview/detail responses and exports a synthetic reconciliation matrix. `overview-launch.spec.ts` covers report ownership, reservations and launch handoffs with keyboard/responsive/axe and representative actual screen-reader checkpoints. Existing analytics, source-access and action-foundation suites retain their boundary and original-outcome recovery coverage. Cloud CI results and the deployed revision are recorded on the owning issue; fixture evidence does not establish a production provider connection.
