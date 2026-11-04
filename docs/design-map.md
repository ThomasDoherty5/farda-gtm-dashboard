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
| Tab | 6:424 | 3 | `SectionTabs` (selected, default) | Built from ACQ03; focus state not checked |
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

## Stock and support comparison (sources 7:129, 7:317)

Same capture settings and build as the Operations comparison. Measured 2026-11-03 at threshold 0.1. Both match the page size and are under the proposed 0.5%.

| Source | Route | Size | Pixels different |
| -- | -- | -- | -- |
| 7:129 Stock per home and transfer | `/inventory` | Matches (1440×1454) | 0.347% |
| 7:317 Support workspace | `/support/cases/TEST-ISS-021` | Matches (1440×1389) | 0.236% |

## Stock and support: intentional differences from Figma

Pending Kevon Baha's confirmation.

| Item | Figma | Code | Why |
| -- | -- | -- | -- |
| Stock title row | "All homes" and "Open inventory" | A third button, "Request transfer", opens a dialog. "All homes" is a URL-backed home filter | The transfer form isn't drawn; the control contract says to implement it, not fake a finished one. It asks for a transfer and moves nothing |
| Health | Healthy or Low stock | Also "Needs review" when Shopify's count disagrees with the movement ledger, with an alert naming both numbers. The ledger balance stays | FE10-02 and FE10-05: observed and movement-derived counts are different facts, and a conflict must show |
| Movement log | Three complete rows | A movement without its receipt reads "Not counted · Receipt not recorded" and a note says it is excluded from balances. Appears only with `?scenario=delayed` | The log's own subtitle says incomplete rows are excluded; the page now shows when that happens |
| Transfer, received units | "Not confirmed" | The same, and the value is an unknown, never a zero | A known zero and an unconfirmed receipt are different states |
| Transfer requests | None | A waiting request shows in an alert: "Waiting for approval. No stock has moved." The request is refused for more than the available units (reserved can't move), a duplicate, the same home or a stale ledger version | A submitted request is not a verified receipt or a depletion |
| Stock fixtures | Typed per screen | Operations, fulfillment analytics and stock all read one set of home balances | OPS270-STOCK-02: the stock and dispatch views must reconcile |
| Support order reference | SH-1042 and TEST-SH-1042 | SH-1031 and TEST-SH-1031 | The lost-shipment case belongs to the order whose shipment is lost; in Figma 4:171, 1042 is still waiting for shipment |
| "14-day cohort" button | A button | A dialog saying what the cohort covers and that the demo holds no other period | No period selector, since there is only one period to choose |
| Case panel | One case, TEST-ISS-021 | The queue rows link to `/support/cases/:caseId`, and the panel shows that case, with a linked shipment or return link | The route has a case id. Next-step text for the other three cases is written for the demo |
| Source buttons | Open source, Open Intercom, Open selected case, View conversation | Handoff dialogs saying no verified link exists | The links are fictional. Nothing replies to, reopens or reassigns a case: Intercom owns that, and the capability reads unsupported |
| Linked shipment | Plain text | A link, in ink with an underline | It reaches the shipment exception |

## Settlement comparison (sources 65:1037, 66:252, 66:447, 9:551)

Same capture settings and build as the Operations comparison. Measured 2026-11-03 at threshold 0.1. All four match the page size. See the table.

| Source | Route | Size | Pixels different |
| -- | -- | -- | -- |
| 65:1037 Commission ledger | `/finance/commissions` | Matches (1440×2185) | 0.435% |
| 66:252 Collabs payout reconciliation | `/finance/settlements/COMM-DEMO-D` | Matches (1440×2111) | 0.576% |
| 66:447 TikTok native settlement | `/finance/settlements/TT-NATIVE-DEMO` | Matches (1440×2194) | 1.037% |
| 9:551 Historical manual fee settlement | `/finance/payables/PAY-0012` | Matches (1440×1506) | 0.601% |

Only the ledger meets the proposed 0.5% mark. The other three are within about 1% and the remaining difference is text and row offsets of a few pixels, plus the items below. Layout was calibrated against each frame's node geometry (`get_metadata`), so panel sizes match exactly. The waterfall's bar heights are computed from the data at Figma's scale (224px for net sales) and match.

## Settlement: intentional differences from Figma

Pending Kevon Baha's confirmation.

| Item | Figma | Code | Why |
| -- | -- | -- | -- |
| Export ledger | A button | A dialog that states the scope (rows, currency, as-of, revision) and builds a UTF-8 CSV in the browser from the loaded snapshot. It is blocked, and never called complete, while the snapshot is partial. Formula-like cells are neutralized | CTRL-117 asks for a server-side snapshot export. With no server, the demo builds the same file from the data it holds and says so. No customer data is in it |
| Review hold, dispute, eligibility | Ghost buttons | Open a read-only evidence dialog | CTRL-119: viewing evidence confirms and changes nothing |
| View receipt, source buttons | Buttons | Handoff dialogs saying no verified link exists | The links are fictional. A paid receipt is immutable |
| Reconcile payout, View payout | Buttons | Links to the Collabs settlement | They lead to the reconciliation screen |
| Match statement | A button | A preview of candidate statement lines. A duplicate or conflicting line can't be selected and stays unresolved. Submitting asks for a review and reports "Approval required"; nothing is marked reconciled | CTRL-118: a versioned submission, and the paid receipt stays immutable |
| Open crosswalk, Review identity | Buttons | Read-only dialogs | CTRL-120 and CTRL-121: no automatic merge, no mapping edit |
| Tabs | Commissions, Payouts, Economics, Provider access | Payouts goes to the Collabs settlement, Economics to the contribution section of the ledger, Provider access to capabilities | There is no separate route for Economics |
| TikTok tabs | Rates & terms, Samples, Native settlement, Exceptions | A tab is `?tab=`. Samples, Native settlement and Exceptions show a labeled panel with no records | Only Rates & terms has a Figma source. Switching never mutates (CTRL-122, CTRL-124) |
| Historical offer models | Three tabs | Three disabled tabs whose accessible description is the section's "read only" sentence | CTRL-127 and CTRL-128: no selection can create an offer |
| Native rate | Unverified | The value is an unknown (never a number) | A rate not read from the source is not 0% |
| Review historical terms, Review adjustment | Buttons | Read-only dialogs | CTRL-126 and CTRL-129 |
| Shell navigation | Creators highlighted on the TikTok settlement | Finance. The fee settlement highlights Creators, as in Figma | The route is shared with the Collabs settlement, which highlights Finance |
| Title-row buttons on the fee settlement | 60px in from the right edge | Right-aligned | Figma's heading is a fixed 850px |
| Founder review | A button | A link to the archived fee approval sample | CTRL-041: navigation only; it neither approves nor pays |
| Execution | "Execution blocked" badge | The same, with the Pay capability unsupported in the adapter | The provider owns payout. No screen offers a manual Pay action |

## Finance comparison (sources 7:510, 7:683, 12:1006)

Same capture settings and build as the Operations comparison. Measured 2026-11-03 at threshold 0.1. All three match the page size.

| Source | Route | Size | Pixels different |
| -- | -- | -- | -- |
| 7:510 Finance dashboard | `/finance` | Matches (1440×1707) | 0.283% |
| 7:683 Close and reconciliation | `/finance/close/2026-10` | Matches (1440×1471) | 0.695% |
| 12:1006 Finance analytics | `/analytics/finance` | Matches (1440×1313) | 0.721% |

The dashboard meets the proposed 0.5% mark; the other two are within about 0.7%, from text and row offsets of a few pixels.

## Finance: intentional differences from Figma

Pending Kevon Baha's confirmation.

| Item | Figma | Code | Why |
| -- | -- | -- | -- |
| Cash chart | An exported static vector (20:409) | An SVG drawn from the plotted source points at the same geometry (gridlines at $70k, $35k and $0; 120px months; 5px solid line, 4px dashed projection, 7px dot). Labels, the table alternative and the accessible name come from the same numbers | FIN272-06: plotted points, axes and labels must agree. A picture can't be checked against the data |
| Projection | Always dashed to January | Drawn only when burn has three months of history and is above zero; otherwise omitted, and runway reads N/A with the reason | FIN272-04 and 05: disclose insufficient history; explain N/A for zero or negative burn |
| Runway and gross margin | Typed text | Derived from cash, burn and the P&L rows (8.0 months, 65.0%) | The numbers can't drift from their sources |
| Year to date | "Awaiting data" | An unknown value shown as "Awaiting data", never zero | A missing report is not a zero |
| The $70,000 raised | Beside cash | Shown as context only; runway uses verified current cash | FIN272-05: never hardcode the historical raise as current cash |
| Last 30 days, View metric definitions | Buttons | Dialogs: the window is fixed, and definitions are read only | Only one window exists in the demo |
| Open QuickBooks, View report folder, Open close checklist | Buttons | Handoff dialogs saying no verified link exists | The links are fictional |
| Open reconciliation | A button | A read-only dialog listing unmatched payouts, posting owner, difference evidence and the CPA policy reference ("Not set") | CTRL-171: navigation never closes the books, and no tax rule is invented |
| Close | Checklist and "4 / 7" | Progress is derived from the checks. There is no close, sign-off or approve control; the capability is held for CPA sign-off and open reconciliation | FE11-03: a count is not a completed close |
| Reports | "Awaiting close" | The same, and "Export failed: rerun pending" with an incomplete-month notice under `?scenario=exportfailed` | FIN274-06: a failed export never reads as a finished package |
| Section navigation | Buttons | Month-end and Reports go to the October close, Unit economics to Financial pulse | The manifest has no separate routes for them |
| Where $12,596 goes | Values typed | The five parts sum to the 30-day receipts, with a test | The breakdown has to reconcile |

## Shared page components

`src/components/Panels.tsx` holds the page furniture the operations, support and finance screens share: PageHeader, Panel, Notice, FactList, Steps, FlatTable and Meter. Measurements come from Figma frames such as 4:6, 4:171 and 4:317. Panels keep a 24px padding and a 1px border. Figma's content width ignores the border, but using 23px padding made the pixel difference worse, so it is left at 24.

## Implementation adaptations

Only Operations has native 390 and 1024 designs. For Overview and the shell, panels stack below 1180px, the header wraps, and the chart scrolls inside a labeled region. These are proposals to review under THO-306, not matches to a design.
