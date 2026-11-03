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
| Source freshness | 6:500 | 5 | Not built | Pending |
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
| Open commerce source, Open review outcomes, Open ad source | Buttons | Dialogs saying there is no verified source link | A fictional link can't perform a live action (SOURCE profile) |


## Implementation adaptations

Only Operations has native 390 and 1024 designs. For Overview and the shell, panels stack below 1180px, the header wraps, and the chart scrolls inside a labeled region. These are proposals to review under THO-306, not matches to a design.
