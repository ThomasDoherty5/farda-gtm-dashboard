# Design-to-code map

Required by handoff section 5 (accuracy gate 2). Figma file: see `figma-access-gap.md`. Captured 2026-11-03.

## Tokens

Every value is in `src/design-system/tokens.css`, named by each variable's Web code syntax.

| Figma | Count | Code |
| -- | -- | -- |
| Farda · Primitives | 16 | `--primitive-*` |
| Farda · Semantic, colors | 16 | `--color-*`, aliasing primitives |
| Farda · Semantic, space | 13 | `--space-*` |
| Text styles | 9 | `--text-*` |

The font is `@fontsource/inter` 4.5.15. The current 5.x build has different letter spacing and matches Figma's render about 2.7× worse, so don't upgrade it without re-running the comparison. Its latin subset has no arrows, so `tokens.css` loads the "all" build for U+2190-2193 only. Without that, "→" falls back to a system font.

## Components

No Code Connect mappings exist. Mappings below are by hand.

| Figma set | Node | Variants | Code | Status |
| -- | -- | -- | -- | -- |
| Button | 2:69 | 8 | `Button`, `LinkButton` (`variant` primary, secondary, ghost; `loading`; `disabledReason`) | Built |
| Badge | 2:80 | 5 | `Badge` (`tone`) | Built |
| Nav item | 2:85 | 2 | `Shell` nav links | Built |
| Alert | 6:616 | 4 | `Alert` (`state`) | Built |
| Empty state | 6:649 | 4 | `EmptyState` (`state`) | Built |
| Skeleton | 6:659 | 2 | `SkeletonCard` | Card built; Row pending |
| Modal | 6:687 | 3 | `Dialog` | Built from the Overview dialogs; set not read yet |
| Input | 6:404 | 5 | `Field`, `TextField`, `SelectField` (label, 48px field, help or error text) | Default, filled and error built; disabled and focus not checked |
| Search | 6:414 | 3 | Not built | Pending |
| Tab | 6:424 | 3 | `SectionTabs` (selected, default) | Built from ACQ03; focus state not checked. The launch and performance pages use a primary-button variant of it (`WorkspaceTabs`, from 14:100) |
| Checkbox | 6:443 | 4 | Not built | Pending |
| Toggle | 6:459 | 3 | Not built | Pending |
| Source freshness | 6:500 | 5 | `Notice` (violet or warning) for the Operations strip | Built for Operations; other states not checked |
| KPI card | 6:516 | 3 | `Kpi`, `KpiRow` | Built from ACQ03. Overview still uses its own cards |
| Table cell | 6:528 | 3 | `DataTable` | Text cell built |
| Table row | 6:557 | 4 | `DataTable` | Default built |
| Table header | 6:564 | 1 | `DataTable` | Built |
| Step | 6:595 | 5 | Not built | Pending |
| Lifecycle/Step | 5:3 | Not counted in the 21 | `Step` in `RunPage` | Built from instances in 5:13 and 5:156 |
| Drawer | 6:703 | 1 | Not built | Pending |
| Toast | 6:710 | 2 | Not built | Pending |
| Tooltip | 6:714 | 1 | Not built | Pending |

## Acquisition comparison (source 102:555)

| Source | Route | Size | Pixels different |
| -- | -- | -- | -- |
| 102:555 | `/creators/discovery` | Matches (1440×2065) | 0.432% |
| 102:364 | `/creators/demo-creator-1/evidence/demo-evidence-1` | 2261 tall, not 2211 (see below) | 0.218%, measured over the top 1450px |
| 102:74 | `/creators/pipeline` | Matches (1440×2552) | 0.264% |
| 6:24 | `/creators/social-cat?view=board` | Matches (1440×1658) | 0.270% |
| 9:143 | `/creators/tiktok?view=board` | Matches (1440×1712) | 0.270% |
| 23:275 | `/creators/social-cat?view=dashboard` | 2601 tall, not 2583 (see below) | 0.266%, measured over the top 2380px; 1.592% over the shared height |
| 23:440 | `/creators/tiktok?view=dashboard` | Matches (1440×2399) | 0.229% |
| 38:131 | `/creators/social-cat/recruitment` | 2737 tall, not 2719 (see below) | 0.356%, measured over the top 2150px; 2.226% over the shared height |
| 38:348 | `/creators/tiktok/invitations/new` | Matches (1440×2658) | 0.298% |
| 66:821 | `/batches/demo-batch-tt-024` | Matches (1440×2298) | 0.230% |
| 9:299 | `/collaborations/demo-collaboration-1?tab=overview` | Matches (1440×1675) | 0.228% |
| 9:436 | `/collaborations/demo-collaboration-1?tab=content` | Matches (1440×1599) | 0.233% |

## Proposed pass mark

Proposed for THO-330, not yet agreed. At threshold 0.1, DPR 1 and the design's exact width:

- Page size matches exactly, unless a listed intentional difference changes it.
- At most 0.5% of pixels differ, checked with `scripts/compare-figma.mjs <path> <capture> 0.1 0.5`.
- The diff image shows only text and edge antialiasing, plus listed intentional differences. A person checks this.
- A screen whose size differs on purpose is judged on its geometry tests and the diff above the first change.

## Overview comparison (source 10:217)

Capture: 1440×1381, DPR 1, Chromium headless, Inter 400/500/600 loaded, America/Los_Angeles, fixture FX-01. Run with `scripts/compare-figma.mjs`. Page size matches exactly, and 0.219% of pixels differ at threshold 0.1 on 2026-11-03. What remains is mostly text and edge antialiasing, plus the intentional differences below. No tolerance is agreed yet (THO-330), so this is a measurement, not a pass.

`e2e/overview-fidelity.spec.ts` checks panel geometry, chart scale, text styles and Button states on every run. All eight Button states are checked in the browser. Pressed and Hover are read from the primary button. Figma's Focus state is applied alongside the extra outline listed below.

## Approval and run comparison (sources 6:234, 5:13, 5:156)

Same capture settings as Overview. The approval and run fixtures reproduce the Figma samples. The sample record is archived, so it shows no decision panel.

| Source | Route | Size | Pixels different |
| -- | -- | -- | -- |
| 6:234 | `/approvals/demo-approval-042` | Matches (1440×1609) | 0.432%, including the changed decision copy |
| 5:13 | `/runs/demo-run-approval?tab=approval` | Matches (1440×1635) | 0.153% |
| 5:156 | `/runs/demo-run-uncertain?tab=recovery` | 1806 tall, not 1672 (see below) | 4.182%, measured over the shared height |

The recovery figure is high because everything below the added evidence controls sits lower, not because those panels differ.

## Settings and automation comparison (sources 7:876, 7:1085, 14:637, 14:911, 66:641)

Owner THO-305. Same capture settings as Overview, against the copy `z9knjMdQ3kxL6Fblvu1tKc`, at threshold 0.1 on 2026-11-03. Measured against a production build (`npm run build` then `vite preview`): the dev server can't serve the fonts through the shared `node_modules` link, so it falls back to a system font and reads about 5%.

| Source | Route | Size | Pixels different |
| -- | -- | -- | -- |
| 66:641 | `/settings/capabilities` | Matches (1440×2015) | 0.212% |
| 14:637 | `/automations` | Matches (1440×2072) | 0.254% |
| 7:876 | `/settings/connections` | 2100 tall, not 2058 (demo footnote and the demo label on the page) | 0.282%, over the top 2000px |
| 7:1085 | `/settings/team` | 1391 tall, not 1349 (demo footnote) | 0.112%, over the top 1280px |
| 14:911 | `/automations/:jobId/schedule` | 2263 tall, not 2099 (see below) | 0.534%, over the top 760px |

The schedule's lower half is checked by eye, with an offset, because the added fields move it down. The pass mark is not met for the schedule's full height, so don't read it as a pass.

## Settings and automation mapping

| Figma | Code | Notes |
| -- | -- | -- |
| Title and actions (7:898) | `PageHeader` in `src/components/PageKit.tsx` | Figma fixes the heading width (850, 860 or 1070), so the buttons follow it |
| Section heading and card (7:918) | `Panel` | 4px or 6px between heading and note, as each screen has it; `large` is the 22px heading |
| Current acquisition policy (109:416), Notice (7:911, 14:672) | `Notice` (`context`, `plain`, `source`) | |
| Detail rows (7:1017) | `DetailRows` | |
| Step rows (7:1228, 14:955), gate rows (70:892) | `Steps`, `Gates` | |
| Table with 16px rows (7:957) | `DataTable variant="ledger"` | Fixed layout, so the design's column widths hold |
| Table with 62px rows (14:743) | `DataTable variant="dense"` | |
| Search (6:414) | `.search` in `PageKit.module.css` | 320 × 48 pill |
| Workspace navigation (14:663) | `AutomationNav` | Links, current page marked with `aria-current` |
| Tab (6:424) on Channel capabilities | `SectionTabs` with `?tab=` | |

## Settings and automation differences from Figma

| Item | Figma | Code | Why |
| -- | -- | -- | -- |
| Demo labeling | None | A footnote under Connections, Team and the schedule says the observations or roles are synthetic. Capabilities keeps Figma's footnote | Demo data is always labeled. This is why Connections and Team are taller |
| Notice on Automation runs | "Design preview · execution access is not validated" | "Demo · execution access is not validated" (without "Demo" on a live environment) | This isn't a design preview |
| Notice on Channel capabilities | "No integration is connected in this design" | "...in this demo", and "No integration is verified" live | Same |
| Connected badges | Static | Labeled demo observations. Check connections re-reads and says no provider was contacted; it never writes a newer timestamp or a healthy result | CTRL-002, and the rule against a faked provider |
| Open source, Open setup, View decision | Buttons with no target | Open a dialog saying no verified link or authorization handoff exists, and that nothing is connected | The demo has no verified URL (SOURCE profile) |
| Request task | Button | Opens a form (registered job type, account, scope, reason), previews the finite plan and creates an approval request | CTRL-006. It never dispatches |
| Take over, View run, View history | Buttons | Dialogs saying a takeover needs a server-confirmed assignment, or that the demo keeps no trace | FE13-04; no fake trace |
| Run filters | Buttons showing the current value | The same, in a radio dialog, plus a search box and Assigned to me toggle, all in the URL. The "Showing n of 7" line shows only while filtered, and is read out always | CTRL-008 to CTRL-012 want a labeled denominator |
| Enable schedule | Disabled | Disabled with the reason attached to the paused-configuration notice | CTRL-014 |
| Schedule fields | Read-only looking inputs | Editable draft: cadence, local time, and a time zone select, with the derived next run and the daylight-saving policy, and a Save draft button | CTRL-017, CTRL-018. Adds about 164px |
| Active-cohort override | Help text only | Help text only; the draft keeps it off | An override needs explicit authorization the demo doesn't have |
| Record permission, Validate (Collabs, API / browser, sample route), Inspect available actions, Plan validation | Buttons | A form that saves evidence with reviewer, date and version; plan dialogs; and an inspect dialog in the URL. None runs a check | CTRL-134, CTRL-136. Evidence is never provider authority |
| Zaps and Reporting tabs | Reporting is the schedule screen | `/automations?tab=zaps` and `?tab=reporting` are small tables; the schedule is at `/automations/:jobId/schedule` | CTRL-015, CTRL-016 |
| Access evidence, Attribution tests, Exceptions tabs | Selected state only | Small tables reading unknown, not run, and nothing recorded | CTRL-131 to CTRL-133 |

## Launch and analytics comparison (sources 3:6, 14:74, 14:377, 30:349, 30:550, 30:721)

Same capture settings as Overview, from Thomas's copy of the file (see `figma-access-gap.md`), measured 2026-11-03 at threshold 0.1 with the Inter fonts loaded. Every page size matches exactly.

| Source | Route | Size | Pixels different |
| -- | -- | -- | -- |
| 3:6 | `/launch?view=snapshot` | Matches (1440×1282) | 0.481% |
| 14:74 | `/launch?view=control` | Matches (1440×2028) | 0.409% |
| 14:377 | `/analytics/attribution` | Matches (1440×2041) | 0.416% |
| 30:349 | `/analytics/paid-media` | Matches (1440×1815) | 0.368% |
| 30:550 | `/campaigns/:campaignId?tab=funnel` | Matches (1440×1777) | 0.274% |
| 30:721 | `/analytics/customer-journey` | Matches (1440×1648) | 0.269% |

What remains is text and edge antialiasing, plus the differences listed below. A person hasn't yet checked the diff images. Run the comparison with a dev server that can read the fonts: if the `node_modules` symlink points outside the worktree, Vite refuses to serve `@fontsource` files, the page falls back to a system font and every figure here doubles or worse. `e2e/analytics.spec.ts` checks each page's height, the KPI card size and the weekly chart's bar scale on every run.

## Scorecards and offer comparison (sources 37:74, 37:251, 65:634, 65:814)

Same capture settings as the analytics screens, measured 2026-11-03 at threshold 0.1 with the Inter fonts loaded. Every page size matches exactly. Two pages are above the proposed 0.5% mark and are reported as not met.

| Source | Route | Size | Pixels different |
| -- | -- | -- | -- |
| 37:74 | `/creators/:creatorId/assessments/demo-assessment-content` | Matches (1440×2125) | 0.457% |
| 37:251 | `…/assessments/demo-assessment-tiktok` | Matches (1440×2143) | 0.479% |
| 65:634 | `/offers/:offerId` | Matches (1440×2080) | 0.638%, not met |
| 65:814 | `…/assessments/demo-assessment-sc-commerce` | Matches (1440×2284) | 0.534%, not met |

The three assessment sources share one path. The record the adapter returns picks the layout (`kind`), so the address never chooses a scoring model. The pixel gap on the other two is text and form-control antialiasing, with native selects drawn slightly differently from Figma's text fields.

## Content monitor comparison (sources 23:73, 25:166, 25:307, 25:481)

Same capture settings as the analytics screens, measured 2026-11-03 at threshold 0.1 with the Inter fonts loaded. Every page size matches exactly. Two pages are just above the proposed 0.5% mark and are reported as not met.

| Source | Route | Size | Pixels different |
| -- | -- | -- | -- |
| 23:73 | `/content` | Matches (1440×1880) | 0.512%, not met |
| 25:166 | `/creators/watchlist` | Matches (1440×1671) | 0.509%, not met |
| 25:307 | `/runs/demo-run-hourly` (a tabless run path) | Matches (1440×1791) | 0.428% |
| 25:481 | `/content/P-001` | Matches (1440×1364) | 0.364% |

The hourly run shares `/runs/:runId` with the approval and recovery views. A `tab` of `approval` or `recovery` selects those; no tab selects the hourly monitor, and a run that isn't an hourly monitoring run says so.

## Intentional differences from Figma

| Item | Figma | Code | Why |
| -- | -- | -- | -- |
| "35%" in the orders bubble | Violet on chartSecondary (4.2:1) | Ink | 12px text needs 4.5:1 |
| Button focus | 4px violetSoft border | That, plus a 2px violet outline | violetSoft alone isn't visible on white |
| Dialog badge | "Interactive prototype" | "Demo" | This isn't the prototype |
| Export dialog title | "Your report preview is ready." | "Report preview", stating no file is generated | No report exists; the handoff bans fake exports |
| Workspace menu | Includes Mobile and Tablet operations, Recovery states, Scheduling preview | Those removed; Approvals and Runs added | Responsive variants are one route; gallery is development-only; nothing else reaches Approvals or Runs |
| Dialog backdrop | Solid ink frame | Ink at 72% | Keeps the page visible behind a modal |
| Navigation header | Static | Sticks to the top from 1024px up | Keeps the demo label persistent, as the handoff requires |
| Approval decisions | None in the app: "Your decision happens in Slack" | Decide in the app or in Slack. A "Decide here" panel on current records, shown when the server offers `decideApproval`, and the queue copy says both. The first decision recorded wins | Product decision, 2026-11-03: Figma needs updating to match |
| Commission terms on an approval | Not shown; the sample is an archived fee proposal | Terms block on current records | The approval contract requires exact terms |
| Recovery controls | Record confirmed sent and Request a fresh attempt always enabled | Disabled with a reason until a source check gives evidence, plus a Check the source control | CTRL-044 and CTRL-045 forbid acting without evidence |
| Queue "Selected" badge | "Selected · pending" | Follows the record's real status | A status label mustn't contradict the record |
| Approval page footnote | "Design preview · sample approval and message…" | "Demo · sample approval and message…", demo only | This is no longer a design preview |
| Source dialog copy | "This prototype previews the handoff and performs no external action." | Says whether a verified link exists | The source-link profile forbids invented destinations, and this isn't the prototype |
| Lifestyle only | A button with no stated behavior | Opens a dialog explaining the locked research scope | CTRL-164 requires an explanation, and the scope must not be widenable |
| Start live discovery | Disabled button | Disabled, with the reason beside it | CTRL-165 requires a visible reason |
| Publishing filter | A button | A radio dialog, and a note that the demo's counts don't split by network | The demo batch isn't split by network, so no result is faked |
| Capacity filter | A button | Filters the capacity table by source | CTRL-162 requires the matching record set to recompute |
| Sample batch preview | Overlay 79:2673 | Dialog built from the same wording, with figures derived from the data | Keeps the text and numbers in step |
| Orders bubbles | Fixed sizes | Fixed sizes | Matches Figma, but sizes aren't data-driven; the labels carry the values |
| Blocked-action reasons (evidence) | Disabled Add observation and Mark watched with no reason | The reasons are listed as text under the buttons, adding about 50px | CTRL-154 requires a visible reason. This is why the page is 2261 tall, not 2211 |
| Video URL field | Placeholder text "Awaiting validated source URL" shown as if populated | A real input, empty at first, with that text as the placeholder | The field has to accept an address |
| Checkout route | Fixed select appearance | Native select | Keyboard and screen reader behavior come for free |
| Observation rows | No way to undo | A Remove link on each recorded observation | Drafts need correcting before they are saved |
| Evidence review state | Static "Pending" values | Coverage is derived from recorded intervals, tied to the video they were recorded against. Changing the address invalidates earlier observations. There is no watched state | CTRL-154 and CTRL-156: a saved draft is never a completed review, and a profile URL is not video evidence |
| Launch snapshot status line | "Sample figures for design preview" | "Demo · sample figures, not connected" | This isn't a design preview |
| Launch snapshot footer | "Design preview · sample figures and creator handles" and "Freshness is shown per source." | "Demo · sample figures and creator handles", and says source freshness isn't connected in the demo | The demo has no per-source watermarks, so the page mustn't claim them (GTM275-07) |
| Decisions waiting copy | "Every creator message gets a human decision in Slack." | "…in the app or in Slack." | Same product decision as the approval screens |
| Creator momentum bars | Unlabeled heights | An illustrative index drawn at one pixel per point, with the values in a text alternative | The heights aren't creator counts, and the card says Illustrative |
| Workspace tabs | Selected tab is a primary button | The same, as links with `aria-current` | A selected tab is a current-view control (CTRL-197, CTRL-202) |
| "GTM overview" tab | No reaction known | Goes to `/launch?view=snapshot` | Assumed, pending Kevon |
| Launch control evidence buttons | Open task, Open run, View proof | A dialog naming the gate and saying the reference is a labeled demo placeholder | CTRL-198: a synthetic reference mustn't look like a completed task |
| Record in Notion | A button | A founder decision editor. Go is disabled while L is unset or a gate is blocked, and Record decision stays disabled with its reason | CTRL-199: nothing may claim a Notion receipt that doesn't exist |
| Proposed L and Reason / evidence | Filled-looking text | Real inputs, empty, with that text as the placeholder. A date must be a real calendar date, and evidence is required | CTRL-200 and CTRL-201 |
| Milestone state once L is set | "Waiting for launch date" | "Waiting for founder approval of L" | A proposed date isn't an approved one |
| Weekly receipts chart | A static tooltip on week 3 | Each week is a button. Week 3 is selected at first, so the page matches Figma. Labels have thousands separators ("$1,200", not "$1200") | Keyboard and screen reader access |
| Creator efficiency footnote | "Fee + sample landed cost + shipping included…" | "Total creator cost = commission, historical accepted fees and sample landed cost, labeled separately…" | FE01-05: new acquisition is commission-only, and historical fees stay labeled |
| Paid media bars | Unformatted values ("3000") | "$3,000" | Currency needs its unit |
| Paid media filters | Two buttons | URL state. The platform filter has no contract row, so it follows the FILTER profile. A "Showing N of M assets" line appears only while a filter is active | CTRL-204, and a denominator must stay visible |
| Metrics as of | A ghost button | Opens a read-only disclosure of source, observation time, timezone, coverage and freshness | CTRL-205 |
| Campaign cohort | One button | Two named cohorts, First-wave and Launch A monitoring. The second shows an empty state | CTRL-207: the handoff says the cohorts are separate, and no figure is invented for Launch A |
| Campaign tabs other than funnel | None | "This tab is not built" | Only the funnel has a design source |
| Primary navigation on `/campaigns` | Overview section | Creators section | Figma's campaign pages are in the Creators group (found by the pixel diff) |
| Commerce bar values | Unformatted ("16000") | "16,000" | Readability |
| Historical scorecard "Hold candidate" | Normal secondary button | Disabled look, with the reason in the note below it | CTRL-064: a historical snapshot has no current opportunity to hold |
| Assessment model buttons | Buttons that look like model choices | Links between the read-only snapshots, with `aria-current` on the current one | The model follows verified checkout, not a client choice (FHC-04) |
| Offer fields | Populated text fields | Real fields. Objective and the $0 upfront fee are read-only, and the objective follows the chosen checkout provider. Publishing network and provider are native selects | CTRL-106 to CTRL-112 |
| Offer actions | Save, Review commitment, Review approval payload | Save sends a validated draft through the adapter and shows only the version the service acknowledged. The two reviews are read-only previews | CTRL-101, CTRL-102, CTRL-114: a draft is not an approval |
| Offer waterfall | A static chart | Drawn from the draft's assumptions on one scale. A nonzero amount is at least 1px tall | Editing the commission recomputes it |
| Monitor filters | Three buttons and a search pill | The same, as URL state. A window with no snapshot (Last 7 days) shows unknown counts, not zeros; a filter or search states "Showing N of M posts" and an empty match says it isn't zero posts | CTRL-048 to CTRL-051 |
| Watchlist cohort control | "Launch cohort A" with every row shown | A named-cohort control. The default keeps all rows and marks members for screen readers; "Launch cohort A only" filters. Sample rows are labeled against the 40-profile total | CTRL-061: the design's default shows rows outside the cohort |
| Watchlist and run next-step links | Plain text with an arrow | Buttons or links styled as that text. Each opens a read-only dialog that names what isn't connected (no verified conversation, post or session link) and changes nothing | CTRL-210 to CTRL-213 |
| Hourly run policy | Populated fields | Read-only fields, with a Manage schedule link in the context line | CTRL-019 to CTRL-021: configuration belongs to THO-305 |
| Retry failed profile | A button | Sends a read-only retry intent through the adapter. The demo's session is expired, so the answer is blocked and the page says nothing ran or was resent | CTRL-022: a retry never bypasses a login |
| Post page for P-002 to P-005 | One post only | Same layout. Without consecutive snapshots the chart says so instead of drawing one | Only P-001 has a daily series in the design |
| Dark coverage card | A border drawn inside | An inset ring, so the card's text width stays 396px | Keeps the design's wrapping |
| Open commerce source, Open review outcomes, Open ad source | Buttons | Dialogs saying there is no verified source link | A fictional link can't perform a live action (SOURCE profile) |

| Pipeline "not N orders" | "12 of 18 published creators · not12 orders" | "… · not 40 orders", derived | Figma's sentence contradicts its own Attributed orders card (40) and drops a space; the figure is derived from the data |
| Pipeline counts after a dot | "10 waiting ·4 declined ·4 expired", "4 queued ·2 reconcile" | A hair space after the dot | Keeps the figures separate while fitting one line, so the row stays 152px as in Figma |
| Pipeline source split | One cohort of 120 with "60 Social Cat" and "60 TikTok Shop" | Even synthetic split per stage, so the source filter recomputes from data | CTRL-149 requires the matching record set to recompute; every split figure is labeled demo |
| Pipeline network, checkout and window filters | Buttons | Accepted and held in the URL; counts don't change, and a note says the demo cohort isn't split by them | CTRL-150–152 need the facets and URL state; no split is faked |
| Cohort window button | "Sep 01–Oct 30" | Same label, with an accessible name "Cohort window: …" | Visible text stays in the name, and the control's purpose is announced |
| Inspect cohort | A button with no stated behavior | A dialog: membership, filters, grain, as-of time, and a stage table of numerators and denominators | CTRL-153; it doubles as the funnel's table equivalent |
| Reconcile uncertain sends | A button | A link to the run recovery view, disabled with a reason when nothing is uncertain | Recovery is where uncertain outcomes are checked; nothing is retried from here |
| Open work queue | A button | A link to the current-stage board for the selected source | The board is THO-294's; the link is the only destination the manifest offers |
| Pipeline funnel | A drawing | The same drawing as a labeled, focusable, scrollable region below 1296px | Responsive adaptation; proposal for THO-306 |
| Pipeline panel padding | 24px with 1px border | 24px, with 22px on the right | Gives the design's 1248px content width inside the 1296px panel |
| Creator cost and sales cards | "—" for Cost per live video and Attributed sales | "N/A", with the same context text | An em dash doesn't say whether the value is unknown or not applicable; the context line gives the reason |
| Lifecycle board "Paid UGC · $150 proposed" | A paid fee proposal card | "12% commission · proposed" | New acquisition is commission-only; a card must not propose an upfront fee |
| Lifecycle board pay approval | "Content approved · 1 video" | "Historical fee · 1 video", with the note "Founder decision required." unchanged | The only fee left is an accepted historical obligation, and the card says so |
| Owner and layout buttons | "All owners" and "Board view" buttons with no stated behavior | Radio dialogs: owners (counts follow the owner) and Board or List layout, both in the URL | CTRL-024 and CTRL-025; the list layout holds the same records |
| Social Cat network buttons | Three buttons with no selected state | The same buttons with a pressed state, in the URL | CTRL-052–054 need a visible selection that recomputes the figures |
| Gated history tabs | Disabled tabs | Disabled tabs, with the reason as visible text in the paragraph below | CTRL-055–057 require a visible reason. This is why the Social Cat dashboard is 2601 tall, not 2583 |
| Source buttons ("Open Notion", "Open Social Cat", "Open TikTok Shop", "Open source") | Buttons | A dialog saying no verified link exists | The source-link profile forbids invented destinations |
| Creator worklist search | A search field | A real search box that filters every column, held in the URL | CTRL-001 |
| Dashboard charts | A picture of a curve | The same curve drawn from the fixture, with a table of daily values | Chart and table equivalents are required, and a filter has to redraw it |
| Stage counts in the funnel strip | "27 / 18 / 15 / 12 / 9 / 6" typed in | Read from the pipeline fixture | The strip and the full funnel can't drift apart |
| Title actions "Review applications" and "Review affiliate queue" | Labels in 166px buttons | 8px side padding | The labels fit the fixed width |
| "Full acquisition funnel" button in the invitation-to-sales panel | 230px wide, set 56px past the panel's content edge | Right-aligned inside the panel | Figma's width overflows the panel |
| Social Cat and TikTok dashboards' tiles | Fixed sizes | Fixed sizes at 1296px, stacking below 1180px | Responsive adaptation; proposal for THO-306 |
| Recruitment gated buttons | Disabled "Sample after acceptance", "Content after agreement" and "Rights to agree" with no reason | Disabled, with one visible paragraph that says what each gate needs | CTRL-085–087 require a visible reason. This is why the recruitment page is 2737 tall, not 2719 |
| Recruitment route filter | A "Campaign applicants" button | Radio dialog: Campaign applicants (the whole queue), Inbound applications, Found by us | CTRL-075 needs explicit allowed values; the queue's own rows carry the route |
| Recruitment duplicate button | A second "Review affiliate terms" in the draft panel | "Open offer terms", or "Reset to the illustrative draft" once edited | Two controls with one name and different jobs can't be told apart |
| Recruitment queue score column | Header "SCORE" with a number per creator in the older frame; "ASSESSMENT" and "Pending" in the current one | "Pending" or "N/A" | The v3 model is unpublished, and a prior v2 score is history, not an assessment |
| Recruitment form fields | Text values | Editable text fields with a visible draft, validation and a leave guard; nothing saves | FIELD profile: no implicit save, errors tied to the field, Cancel and leave behavior declared |
| Draft message | Fixed text | Built from the draft's rate, so it can't contradict the terms | The message and the terms must agree before any approval |
| Invitation start and expiry | "Set before approval" and "7-day validity · proposed" shown as values | Empty fields with those words as placeholders, in "YYYY-MM-DD HH:mm PT" | CTRL-097 and 098 need exact timestamps; a seven-day validity is a proposal, not a value |
| Invitation fit score card | "Priority review · hard gates pending" | "Prior v2 · read-only · hard gates pending" | A v2 score is history and must be labeled |
| Invitation "Send request · blocked" | Disabled button | Disabled, with the page's own "Pending: …" paragraph as its description | CTRL-100 requires a visible reason without adding a line |
| Invitation preview buttons | Buttons | Dialogs of synthetic examples, and a link to run recovery for the uncertain case | Previews must say nothing was sent |
| Batch pause and cancel | Buttons | Real commands through the adapter with a preview, an expected version and an idempotency key; they touch unsent items only | CTRL-137, 141 and 148 |
| Batch active navigation item | Automations | Automations | `/batches` now belongs to the Automations section instead of Creators |
| Batch tabs "Exceptions" and "Capacity" | No frame in this source | `?tab=exceptions` and `?tab=capacity`, listing only the batch's own records, labeled as having no Figma source | CTRL-139 and 140 need a target; nothing is invented beyond the data |
| Batch "Operations queue" tab | Current view in the contract | A link to `/automations` | The batch detail is the current view; the queue is its parent |
| Batch "Model: current v3 pending" | A button | Read-only status text with the same look | CTRL-145: no model picker |
| Batch "Owner / deadline" | One button | Owner radio dialog; the deadline half is not built | The demo data has owners but no deadlines |
| Batch table rows | Five rows | One example for each state, stated in the table's caption | The table is a sample of 24 approved items, and says so |
| Collaboration commands (Queue next action, Queue feedback, Request revision, Reject, Close, Suppress, Create new) | Buttons | Dialogs that validate (a reason, an allowed outcome, the current submission, revision rounds left) and queue a request for approval through the adapter, with an expected version and idempotency key. Nothing is sent, closed or suppressed | CTRL-029, 032–034, 036, 039, 040: a queued request is not an approved one, and approved is not sent |
| Collaboration "Approve content" | Disabled button | Disabled, with the page's own sentence "Acceptance remains blocked while the required license is missing." as its description | CTRL-038; derived from the rights data, so it opens when a signed license exists |
| Collaboration tabs | Overview, Brief, Content, Messages, Payments on one frame; Collaboration, Content review, Rights, Payments on the other | The same tabs, each in the URL (`?tab=`). Brief, Messages, Payments and Rights have no Figma frame: they show only data the record holds and say so | CTRL-030, 031, 037 need a target for each tab; nothing is invented beyond the data |
| Review after | A typed date | Derived from the posting due date and the grace period | The two inputs can't disagree with the result |
| Agreed fee on COL-SC-042 | "USD 150" | "USD 150", read-only, labeled as an accepted historical term in the page's own context box | The one place a fee may appear; no control can create or repeat it |
| Queued requests | None | A short list "Requests awaiting approval" appears under the context box once something is queued | The queue must be visible, or a queued action looks like nothing happened |

## Operations comparison (sources 4:6, 4:171, 4:317, 12:292, 12:431, 12:808, 12:708, 12:653)

Same capture settings as Overview, on a production build (a dev server can't load the font here). Measured 2026-11-03 at threshold 0.1 against the copy `z9knjMdQ3kxL6Fblvu1tKc`. Against the proposed pass mark (not agreed): sizes match and at most 0.5% differ for six of the eight; the 390 and 1024 variants and the active return do not meet it.

| Source | Route | Size | Pixels different |
| -- | -- | -- | -- |
| 4:6 Operations overview | `/operations` | Matches (1440×1452) | 0.294% |
| 4:171 Order detail | `/orders/TEST-SH-1042` | Matches (1440×1331) | 0.243% |
| 4:317 Shipping exception | `/shipments/TEST-SP-0093/exceptions/TEST-EVT-129` | Matches (1440×1119) | 0.142% |
| 12:292 Return/replacement | `/returns/TEST-RET-028` | 1469 tall, not 1423 (see below) | 0.199% over the top 1285px; 3.021% over the shared height |
| 12:431 Return resolved | `/returns/TEST-RET-028?scenario=resolved` | Matches (1440×846) | 0.362% |
| 12:808 Fulfillment analytics | `/analytics/fulfillment` | Matches (1440×1287) | 0.374% |
| 12:708 Tablet operations | `/operations` at 1024 | Matches (1024×1078) | 2.664%, mostly the shell navigation (see below) |
| 12:653 Mobile operations | `/operations?home=H2` at 390 | 1424 tall, not 1366 | 21.097% over the shared height, mostly because the shell navigation is taller and shifts everything below it |

The 1024 and 390 figures are not a pass, and the 390 figure says little about the page content, because the shell above it differs. Operations is the only screen with native 1024 and 390 designs, so these are the first real responsive targets; the shell's own responsive design is for THO-306 to decide.

`e2e/operations.spec.ts` checks page heights against Figma, panel geometry, the chart scale (6.75px per order) and both compositions on every run.

## Operations: intentional differences from Figma

Pending Kevon Baha's confirmation.

| Item | Figma | Code | Why |
| -- | -- | -- | -- |
| "All homes" button | A button | Opens a radio dialog and filters by `home` in the URL. The button shows only the choice, as Figma does; its accessible name includes "Home:" | CTRL-162-style filter: scope has to survive a reload and Back (OPS270-06) |
| Queue subtitle | "Orders and approved samples · oldest first" | Adds " · showing 5 of 18" when the list is partial | The table shows the oldest 5 of 18; saying so stops it reading as the whole queue |
| Held work | Not shown | A separate "held, not ready to leave home" panel appears only when the data has holds, each with its reason and the source action | OPS270-03: held work never appears ready to dispatch. The default fixture has none, so the 1440 page height is unchanged |
| Orders and Shipping tabs | Buttons | `?view=orders` and `?view=shipping` filter the same page. Stock goes to `/inventory`, Support to a support case | CTRL-167 needs an order list; the manifest has no separate route for it |
| Operations overview, 1024 | Open source button 350px after the title | Right-aligned | The design's spacer is a fixed width; right-aligned holds up at other widths |
| Operations overview, 1024 and 390 | No home control | Home scope can still be set by the `home` value in the URL; the 1440 page has the control | The native compact designs don't draw one. This needs a design decision |
| Operations, 1024 | Navigation shows "More" and no demo badge, and no brand mark | The shell keeps Automations and the Demo workspace badge, drops the brand mark and tightens item widths so it fits one row | The demo label must stay visible; "More" has no destination in the manifest |
| Operations, 390 | Menu button in place of navigation; one queue card TEST-SH-1044 | The shell is unchanged (wrapped navigation). TEST-SH-1044 is not in the data, and an added "needs attention" card links to the shipping exception | Changing the shell navigation at 390 breaks existing journeys on every screen. TEST-SH-1044 at 18 hours would also contradict the 1440 oldest-first list. The exception card is the only way to reach exceptions on a phone |
| Shell active section | Overview highlighted for analytics | `/analytics/fulfillment` highlights Operations and `/analytics/finance` highlights Finance | Figma 12:808 highlights Operations |
| Shipping exception | Order key SHOP-TEST-1042 | SHOP-TEST-1031 | In Figma 4:171 that key is a different order, still waiting for shipment. The demo ties the shipment to its own order |
| Shipping exception | Two buttons | A third, "Record next step", opens a dialog for the one in-app intent | FE09-04: an intent with actor, reason and expected version. It records a choice for approval and refunds nothing |
| Order detail | One sample order | Also TEST-SH-1031 (every milestone) and TEST-SC-0081 (a creator sample, with total N/A) | FE09-02 and OPS270-04: milestones and identities stay separate. A sample's total is N/A, never $0 |
| Return fields | Text that looks like fields | A native select for disposition and resolution, a text field for reason, and a reset | CTRL-173 to CTRL-175 describe real, draft fields. Native selects show a chevron |
| Return, "Close unavailable" | No reason shown | One line: "Needs the inventory receipt, refund settlement and QuickBooks posting." | CTRL-214 requires a visible reason. This is why the active page is 46px taller |
| Return, "Prepare browser task" | Always enabled | Submits an approval request, reports "Prepared, waiting for approval", then disables | A click is not a refund, restock or shipment, and a second outcome is refused |
| Return resolved | Same case as the active one | `?scenario=resolved`, a demo-only value | The demo has one return. A live record's state decides the variant |
| Preview replacement plan | Button | Dialog built from the record, no adapter call | CTRL-176: a preview neither refunds nor ships. The adapter's preview intent waits for THO-283 |
| Fulfillment period | "Last 14 days" button | A radio dialog with 7 and 14 days. At 7 days the prior period reads N/A and the delivery mix is unavailable | The demo holds 14 days of daily rows. Everything shown is derived from them, so the cards, chart and table agree |
| Fulfillment chart | Picture of bars | Bars plus an accessible name and a hidden data table | FE09-08 requires a chart alternative |
| Source dialogs | "Open Shopify", "Open Shippo", "Open source row" and similar | Handoff dialogs saying no verified link exists | The links are fictional. FE09-06 and the SOURCE profile forbid guessing a destination |

## Shared page components

`src/components/Panels.tsx` holds the page furniture the operations, support and finance screens share: PageHeader, Panel, Notice, FactList, Steps, FlatTable and Meter. Measurements come from Figma frames such as 4:6, 4:171 and 4:317. Panels keep a 24px padding and a 1px border. Figma's content width ignores the border, but using 23px padding made the pixel difference worse, so it is left at 24.

## Implementation adaptations

Only Operations has native 390 and 1024 designs. For Overview and the shell, panels stack below 1180px, the header wraps, and the chart scrolls inside a labeled region. These are proposals to review under THO-306, not matches to a design.
