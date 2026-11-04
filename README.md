# Farda GTM dashboard (frontend)

This is the frontend for the Farda GTM operations dashboard. It is built from Kevon's Linear handoff, "Farda frontend — scoped Figma-to-code handoff" (revised 2026-11-02), and these companion documents:

- control behavior and state contracts
- adapter contracts, fixtures and verification

## Status: work in progress (phase 1 foundation)

**Done**
- Vite, React, TypeScript and React Query scaffold, with strict TypeScript, ESLint, Vitest and Playwright configured.
- A typed adapter seam (`src/adapter/`), transcribed from the adapter document, sections 2–5. Its status is *proposed*; THO-283 freezes it.
  - Zod schemas for the contract types.
  - Error-category mapping.
  - A demo adapter. It uses a frozen clock, never dispatches, and every capability reports `unverified`.
  - A live adapter stub. It fails with `INTEGRATION_PENDING` and never falls back to demo data.
- `useView`, which scopes query keys and aborts stale requests. It rejects a response whose scope doesn't match the request.
- A scope provider that clears cached data when the scope changes.
- Overview fixtures FX-01 to FX-09, from the dataset "overview-original": 400 orders / $12,596; 5 posts, 240k views, 5.0% engagement; 180 attributed orders / $5,796. Select one with `?fixture=FX-04`, for example.
- 60-source route manifest:
  - `docs/figma-source-manifest.md` is copied verbatim from the handoff.
  - `npm run manifest:generate` builds `src/routes/manifest.generated.ts` from it.
  - Every route renders. Unbuilt routes show an honest placeholder that names the owner issue and the Figma source node.
- The shell has a skip link, horizontal navigation, a main landmark and a demo banner that is always visible.
- Button behavior: loading, and disabled with a reason.
- Overview data slice (`/overview`, source 10:217):
  - six metrics with provenance
  - known zero is distinct from N/A
  - stale, partial, empty and error states

- Unit and contract tests (`src/**/*.test.ts(x)`), Playwright smoke and axe tests (`e2e/`), and a CI workflow.
- `AGENTS.md`, `docs/intake.md` and `docs/figma-access-gap.md`.

- Approval flow behavior (THO-296): approval detail and history, agent run approval and unknown-outcome recovery, on an in-memory demo state machine covering FX-10 to FX-18. Start at `/approvals` or `/runs`. Demo state resets on reload. Its three screens are built from Figma sources 6:234, 5:13 and 5:156.
- Daily sourcing (`/creators/discovery`, source 102:555, THO-287): the draft plan, capacity table, URL-backed filters, and the locked live-discovery and research-scope controls. Demo data only.
- Video evidence review (`/creators/:creatorId/evidence/:evidenceId`, source 102:364, THO-288): save a partial review of an Instagram or TikTok video address, time-coded observations and the checkout route. A saved draft is never a completed review, Mark watched stays blocked until playback can be verified, and profile addresses are refused. Saves go through the adapter's `saveResource` with version checks and idempotency keys. Demo data only; reviewer disagreement and override are not built.
- Operations (THO-301): the overview with its native 1024 and 390 compositions (`/operations`, sources 4:6, 12:708, 12:653), order detail, shipping exception, return and replacement in its active and resolved states, and fulfillment analytics. All read-only mirrors, except two intents that only queue a request for approval: record a shipping decision, and prepare a return task. Neither refunds, ships nor restocks, and both report "waiting for approval". Demo data only; `?scenario=` selects labeled fixtures (holds, stale, empty, unknown, unavailable, resolved).
- Stock per home and transfer (`/inventory`, source 7:129) and the support workspace (`/support/cases/:caseId`, source 7:317, THO-302): physical on-hand from movements kept apart from Shopify's count, reservations that change Available but not On hand, a transfer request that queues for approval and moves nothing, and the 14-day support cohort with its all-time queue kept separate. Demo data only; `?scenario=` selects conflict, delayed, stale, unread and unavailable fixtures.
- Creator payable and provider-owned settlement (THO-300): the commission ledger (`/finance/commissions`, 65:1037), Collabs payout reconciliation and TikTok native settlement (`/finance/settlements/:settlementId`, 66:252 and 66:447) and the historical manual fee settlement (`/finance/payables/:payableId`, 9:551). Every total is derived from the group rows; earned, held, disputed, awaiting-provider and paid stay separate; there is no Pay action; the ledger exports a UTF-8 CSV of the whole snapshot and refuses a partial one; a statement match is submitted for review, never marked reconciled. Demo data only.
- Full acquisition pipeline (`/creators/pipeline`, source 102:74, THO-289): the opportunity funnel with previous-stage conversion and median days, source-native match versus accepted terms, send outcomes (confirmed, uncertain, queued) kept apart from approvals and attempts, exclusive current-stage counts, and commerce outcomes. The source filter is URL-backed and recomputes; the other facets are accepted but the demo cohort doesn't split by them, and the page says so. Read work only, demo data only.
- Social Cat and TikTok Shop (`/creators/social-cat` and `/creators/tiktok`, `?view=board` or `?view=dashboard`, sources 6:24, 9:143, 23:275, 23:440, THO-294): the Social Cat lifecycle board (owner filter and list layout), the TikTok funnel board (worklist search), and both dashboards (publishing-network filter on Social Cat, charts with table equivalents, the Launch cohort kept apart from the acquisition funnel and from the pilot cohort). Gifted, paid and hybrid history tabs are read-only. Read work only, demo data only.
- Recruitment and batch (`/creators/social-cat/recruitment`, `/creators/tiktok/invitations/new`, `/batches/:batchId`, sources 38:131, 38:348, 66:821, THO-298): the Social Cat recruitment queue and affiliate-terms draft, the TikTok invitation draft with exact start and end times, and the finite batch with real pause and cancel-unsent commands through the demo adapter. Nothing sends, approves or accepts. Demo data only.
- Collaboration detail and content review (`/collaborations/:collaborationId?tab=overview` and `?tab=content`, sources 9:299 and 9:436, THO-295): the relationship record with its accepted historical terms, timeline and outreach eligibility, and the draft review with its checklist and rights register. Every command only queues a request for approval; approving content stays blocked while the license is missing. Demo data only.

- Launch and analytics screens (THO-293), on demo datasets in `src/fixtures/analytics.ts` that reconcile to the Overview's 400 orders / $12,596: Launch snapshot (`/launch?view=snapshot`, source 3:6), Launch control (`?view=control`, 14:74), Performance attribution (`/analytics/attribution`, 14:377), Paid media (`/analytics/paid-media`, 30:349), Campaign funnel (`/campaigns/:campaignId?tab=funnel`, 30:550) and Commerce, support and reviews (`/analytics/customer-journey`, 30:721). Every metric shows its denominator and window, a missing input reads N/A with a reason, and L stays unset. Nothing here records a launch decision, approves a date or opens a provider record. Filters are URL state.

- Scorecards and offer economics (THO-297): the Content quality (37:74), TikTok commerce (37:251) and Social Cat commerce (65:814) scorecards at `/creators/:creatorId/assessments/:assessmentId`, and Offer and economics (65:634) at `/offers/:offerId`. The scorecards are read-only historical v2 snapshots; a missing rating shows Needs data, never a rescaled total. The offer is a commission-only draft: a locked $0 upfront fee, fixed-per-sale gated, and a save through the adapter that shows only the acknowledged version. Demo data in `src/fixtures/scorecards.ts`.

- Content monitor and watchlist (THO-299): Content monitor (`/content`, 23:73), Watchlist (`/creators/watchlist`, 25:166), Hourly run (a tabless `/runs/:runId`, 25:307) and Post performance (`/content/:postId`, 25:481). Monitoring is read-only. Views, engagement, attributed orders and net sales keep their window and denominator; a missing count is N/A, never zero; a retry never bypasses a login. The demo posts reconcile to the Overview's 240,000 views and 180 orders. Demo data in `src/fixtures/monitor.ts`.

- Real Figma tokens (all 45 variables and 9 text styles), Button, Badge, Alert, Empty state, Skeleton, Dialog, the shell and Overview (source 10:217), compared against Figma. See `docs/design-map.md`.

**Not done yet**
- **Figma for in-app approval decisions.** They were approved after the design, which still shows Slack only. See `docs/design-map.md`.
- **The other 13 component sets** in `docs/design-map.md`, and responsive review against the native Operations references.
- **The rest of THO-296:** the takeover dialog's real copy, real Slack handoff, login/MFA and denied-permission run states, and the separate provider settlement dialogs. `saveResource` is typed, but nothing uses it yet.
- **Overview's real date range and export.** They need THO-283, so both dialogs say what's missing.
- **The other sources.** They render labeled placeholders. The approval flow's history views use the design's components, but have no Figma source of their own.

## Commands

```
npm install
npm run dev          # http://localhost:5173 (demo adapter)
npm run verify       # typecheck + lint + unit tests + build
npm run test:e2e
npm run manifest:generate
node scripts/compare-figma.mjs /overview .handoff/figma/overview-10-217.png   # pixel diff against a local Figma capture
```

## Rules carried from the handoff
- Never put secrets in the client, URLs or browser storage.
- No live dispatch from demo.
- Demo data is always labeled, and the app never silently falls back to it.
- Accessibility targets WCAG 2.2 AA. Test at widths 390, 768, 1024, 1440 and 1920, at 200% zoom, and with 320px reflow.
- Make no fidelity claims without a Figma comparison.
