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
| Skeleton | 6:659 | 2 | `Skeleton`, `SkeletonCard`, `SkeletonRow` (`src/components/EmptyState.tsx`, re-exported from `Skeleton.tsx`) | Built (Card is on every route's loading state; Row has no screen yet, since no list loads on its own) |
| Modal | 6:687 | 3 | `Modal` (`state` confirm, access, reconcile; `busy`; `confirmDisabledReason`), a 460px compact confirmation. `Dialog` stays the 560px form dialog from 51:1945 | Built. Read from 6:687: Confirm and Access say "Continue", Reconcile says "Open source". No screen uses it yet; the existing two-button confirms put the primary action first, which is a different order |
| Input | 6:404 | 5 | `Field`, `TextField`, `SelectField` (label, 48px field, help or error text) | Default, filled and error built; disabled and focus not checked |
| Search | 6:414 | 3 | `SearchField` (`label`, `placeholder`, `fluid`). Default is the placeholder, Query is the value, Focus is the 2px violet border on `:focus-within` | Built; replaces the three local copies (Automation runs, TikTok worklist, Content monitor) |
| Tab | 6:424 | 3 | `SectionTabs` (selected, default) | Built from ACQ03; focus state not checked. The launch and performance pages use a primary-button variant of it (`WorkspaceTabs`, from 14:100) |
| Checkbox | 6:443 | 4 | `Checkbox` (`checked`, `mixed`, `disabled`, `readOnly`, `describedBy`) over a native input | Built; replaces the locked policy list. The settlement match list keeps its own multi-line rows |
| Toggle | 6:459 | 3 | `Toggle` (`role="switch"`, `disabledReason`) | Built. No screen uses a switch: the design draws filters such as Assigned to me as pressed buttons |
| Source freshness | 6:500 | 5 | `SourceFreshness` (`state` live, synced, stale, unknown, error). Unknown never shows a time. The page-level strip stays `Notice` (violet or warning) | Built; all five states unit-tested. No screen uses the card yet |
| KPI card | 6:516 | 3 | `Kpi`, `KpiRow` | Built from ACQ03. Overview still uses its own cards |
| Table cell | 6:528 | 3 | `DataTable` | Text cell built |
| Table row | 6:557 | 4 | `DataTable` | Default built |
| Table header | 6:564 | 1 | `DataTable` | Built |
| Step | 6:595 | 5 | `StepCard` (`state` pending, approval, running, completed, failed) | Built. The row form is Lifecycle/Step 5:3 below; no screen uses the card |
| Lifecycle/Step | 5:3 | Not counted in the 21 | `Step` in `RunPage` | Built from instances in 5:13 and 5:156 |
| Drawer | 6:703 | 1 | `Drawer` (title, badge, detail rows, note, action) as a right-docked modal dialog | Built. No screen opens one yet |
| Toast | 6:710 | 2 | `Toast`, `ToastProvider`, `useToast` (success polite and self-clearing; error alert, kept until dismissed) | Built. Screens keep their in-flow `role="status"` lines, which sit next to the control that acted |
| Tooltip | 6:714 | 1 | `Tooltip` (hover, focus, Escape; describes its trigger) | Built. Disabled reasons stay visible text, never tooltip-only |

## Measured comparison, first half of the screens (fidelity sweep 1, THO-330)

Measured 2026-11-03 against the copy `z9knjMdQ3kxL6Fblvu1tKc` (see `figma-access-gap.md`), at threshold 0.1, DPR 1, the design's exact width of 1440, Chromium headless, Inter 400/500/600 loaded, America/Los_Angeles, demo fixtures. Run `npm run build`, then `npx vite preview --port 4181` and `BASE_URL=http://localhost:4181 node scripts/compare-figma.mjs <route> .handoff/figma/<capture>.png 0.1`. Use a production build: `vite dev` can't serve the `@fontsource` files through the shared `node_modules` link, falls back to a system font and reads about 5%.

Every row meets the pass mark (0.5% of pixels) except where "judged over" says why the page height differs. For those, the percentage is over the top of the page, above the first intentional change, and the screen is judged on its geometry tests. These are fixture-complete measurements against a copy of the design; the mark is agreed by Thomas but not yet by Kevon, so this is not a release pass. The agent that wrote the code looked at the diff images of the screens it changed (text and edge antialiasing, the copy differences listed below). The design owner hasn't.

| Source | Route | Size | Pixels different |
| -- | -- | -- | -- |
| 10:217 | `/overview` | Matches (1440×1381) | 0.219% |
| 6:234 | `/approvals/demo-approval-042` | Matches (1440×1609) | 0.432% |
| 5:13 | `/runs/demo-run-approval?tab=approval` | Matches (1440×1635) | 0.153% |
| 5:156 | `/runs/demo-run-uncertain?tab=recovery` | 1806 tall, not 1672 (added evidence controls) | 0.162%, judged over the top 1030px |
| 102:555 | `/creators/discovery` | Matches (1440×2065) | 0.431% |
| 102:364 | `/creators/demo-creator-1/evidence/demo-evidence-1` | 2267 tall, not 2211 (blocked-action reasons, +56) | 0.179%, judged over the top 1700px |
| 102:74 | `/creators/pipeline` | Matches (1440×2552) | 0.264% |
| 6:24 | `/creators/social-cat?view=board` | Matches (1440×1658) | 0.270% |
| 9:143 | `/creators/tiktok?view=board` | Matches (1440×1712) | 0.270% |
| 23:275 | `/creators/social-cat?view=dashboard` | 2601 tall, not 2583 (read-only history reason wraps, +18) | 0.221%, judged over the top 2380px |
| 23:440 | `/creators/tiktok?view=dashboard` | Matches (1440×2399) | 0.229% |
| 38:131 | `/creators/social-cat/recruitment` | 2737 tall, not 2719 (gate reason wraps, +18) | 0.356%, judged over the top 2150px |
| 38:348 | `/creators/tiktok/invitations/new` | Matches (1440×2658) | 0.298% |
| 66:821 | `/batches/demo-batch-tt-024` | Matches (1440×2298) | 0.230% |
| 9:299 | `/collaborations/demo-collaboration-1?tab=overview` | Matches (1440×1675) | 0.228% |
| 9:436 | `/collaborations/demo-collaboration-1?tab=content` | Matches (1440×1599) | 0.233% |
| 3:6 | `/launch?view=snapshot` | Matches (1440×1282) | 0.434% |
| 14:74 | `/launch?view=control` | Matches (1440×2028) | 0.174% |
| 14:377 | `/analytics/attribution` | Matches (1440×2041) | 0.416% |
| 30:349 | `/analytics/paid-media` | Matches (1440×1815) | 0.203% |
| 30:550 | `/campaigns/demo-campaign-first-wave?tab=funnel` | Matches (1440×1777) | 0.208% |
| 30:721 | `/analytics/customer-journey` | Matches (1440×1648) | 0.269% |
| 37:74 | `/creators/demo-creator-1/assessments/demo-assessment-content` | Matches (1440×2125) | 0.375% |
| 37:251 | `…/assessments/demo-assessment-tiktok` | Matches (1440×2143) | 0.386% |
| 65:634 | `/offers/demo-offer-1` | Matches (1440×2080) | 0.407% |
| 65:814 | `…/assessments/demo-assessment-sc-commerce` | Matches (1440×2284) | 0.210% |
| 23:73 | `/content` | Matches (1440×1880) | 0.343% |
| 25:166 | `/creators/watchlist` | Matches (1440×1671) | 0.233% |
| 25:307 | `/runs/demo-run-hourly` (a tabless run path) | Matches (1440×1791) | 0.190% |
| 25:481 | `/content/P-001` | Matches (1440×1364) | 0.364% |

What the sweep changed, found by reading the diff images against the capture:

- The campaign funnel highlighted Overview in the navigation; Figma highlights Creators. The lifecycle merge had put `campaigns` back under Overview.
- Figma lays tables and field rows out at the card's 1248px content width. A bordered card leaves 1246px, so every column sat 1px or 2px left. Analytics tables, the offer's field row, and the scorecard evidence and gate grids now extend the 2px at 1180px and wider.
- The two commerce tables (`cell12`) had a semibold first cell, muted other cells and no left padding; Figma has regular ink text, 12px padding everywhere.
- Evidence: "TikTok footage" is "TikTok Shop footage" as in Figma, and the observation columns are 260, 190 and 190px exactly.
- Social Cat dashboard and recruitment: 16px between the offer buttons, not 10px, and the dashboard's network buttons are 224, 112 and 100px wide.
- Scorecard context row text sits at the top of the row, as in Figma; the launch snapshot's "Open creator workspace" link too, and the decision ages sit in a 72px column.

What stays above 0.4% is text and edge antialiasing plus copy differences (below), and the placement of figures inside bar charts, which a person should check.

The lowest pages sit at 0.15 to 0.2% even where every box matches, which looks like the floor from text antialiasing between Figma's renderer and Chromium. That's an inference from the diff images, not something checked.

### Page heights on other platforms

The Linux CI runner lays text out slightly narrower than macOS, so a line that overflows its box by a few pixels on macOS can fit on Linux and make a page 18px shorter. The cause is deterministic and was found by comparing each text block's single-line width with its box. Three notes overflowed by a word (0.2% to 1.4%): the invitation's route note, the batch's illustrative-batch note and the evidence page's denominator note. Each now has a line break (`wide-break`, 1180px and wider) before its last word, so the line count is the same on every platform, and the invitation, batch and evidence height checks are exact again. Paid media's note already has a 36px minimum height. Not changed: Automation runs' height check in `e2e/settings.spec.ts` still allows one 18px line (second fidelity sweep's screen).

## Pass mark

For THO-330. Thomas Doherty agreed this mark on 2026-11-04 and confirmed the copy of the Figma file is current; Kevon Baha hasn't confirmed either. At threshold 0.1, DPR 1 and the design's exact width:

- Page size matches exactly, unless a listed intentional difference changes it.
- At most 0.5% of pixels differ, checked with `scripts/compare-figma.mjs <path> <capture> 0.1 0.5`.
- The diff image shows only text and edge antialiasing, plus listed intentional differences. A person checks this.
- A screen whose size differs on purpose is judged on its geometry tests and the diff above the first change.

## Overview comparison (source 10:217)

Capture: 1440×1381, DPR 1, Chromium headless, Inter 400/500/600 loaded, America/Los_Angeles, fixture FX-01. Run with `scripts/compare-figma.mjs`. Page size matches exactly, and 0.219% of pixels differ at threshold 0.1 on 2026-11-03. What remains is mostly text and edge antialiasing, plus the intentional differences below. No tolerance is agreed yet (THO-330), so this is a measurement, not a pass.

`e2e/overview-fidelity.spec.ts` checks panel geometry, chart scale, text styles and Button states on every run. All eight Button states are checked in the browser. Pressed and Hover are read from the primary button. Figma's Focus state is applied alongside the extra outline listed below.

## Approval and run comparison (sources 6:234, 5:13, 5:156)

Same capture settings as Overview. The approval and run fixtures reproduce the Figma samples. The sample record is archived, so it shows no decision panel.

The measured table is in "Measured comparison, first half of the screens" above.

The recovery page is 134px taller because of the added evidence controls, so below them every panel sits lower. The table above judges it over the top 1030px, above the first change.

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

## Customer lifecycle comparison (sources 5:289, 5:404, 11:372, 11:498, 11:624, 11:750, 11:852)

Owner THO-304. Same capture settings and method as the settings comparison above (copy `z9knjMdQ3kxL6Fblvu1tKc`, threshold 0.1, DPR 1, production build, 2026-11-03).

| Source | Route | Size | Pixels different |
| -- | -- | -- | -- |
| 11:750 | `/customers/consent` | 1318 tall, not 1276 (demo footnote) | 0.098%, over the top 1230px |
| 5:289 | `/customers/lifecycle` | 1411 tall, not 1369 (demo footnote) | 0.235%, over the top 1320px |
| 11:372 | `/customers/flows/early-access` | 1378 tall, not 1302 (see below) | 0.47%, over the top 840px |
| 11:498 | `/customers/flows/abandoned-checkout` | 1378 tall, not 1302 | 0.469%, over the top 840px |
| 11:624 | `/customers/flows/review-request` | 1378 tall, not 1302 | 0.467%, over the top 840px |
| 11:852 | `/customers/activation` | 1148 tall, not 1106 (demo footnote) | 0.611%, over the top 1070px. **Not met** |
| 5:404 | `/customers/flows/setup` | 1365 tall, not 1323 (demo footnote) | 0.68%, over the top 1290px. **Not met** |

Activation and Setup sit just over the proposed 0.5% mark, from sub-pixel text positions; the diffs show only text and edge antialiasing. The three flow pages are checked over their top 840px only, because the added policy note moves the lower half. These are measurements against a proposal, not a pass.

## Customer lifecycle mapping

| Figma | Code | Notes |
| -- | -- | -- |
| Context (5:322), Flow context (11:398) | `ContextLine` in `PageKit` | A badge and one line |
| Secondary navigation (5:315) | `PillNav` | Pills as links; the current one has `aria-current` |
| Lifecycle/Step (5:3) | `FlowSteps` in `features/lifecycle/shared.tsx` | An ordered list; a hold is a word as well as a color |
| Input (6:404) and Checkbox (6:443) in Flow settings | `Field`, `SelectField`, `TextField`, and `LockedPolicies` | The checkbox set is read-only and checked, with no way to change it |
| Consent distribution (11:799) | `.bar` with a text alternative | Segment widths are the counts over the total |
| Progress (5:387, 11:889) | `role="progressbar"` | Each is named, with a value |
| Table with 16px rows (5:353) | `DataTable variant="ledger"` | |

## Customer lifecycle differences from Figma

| Item | Figma | Code | Why |
| -- | -- | -- | -- |
| Demo labeling | None | A footnote on every page: the figures are illustrative aggregates | Demo data is always labeled |
| Open email tool, Open provider, View source contract, Demo cohort | Buttons with no target | Dialogs saying there is no provider, verified link or other cohort | The demo has no verified URL, and no provider is selected |
| Metric definitions | Button | A dialog of definitions written from the screen's own labels | The definitions are mine, to confirm |
| Flow names on the lifecycle | Plain text | Links to each flow, drawn the same | FE12-05: flows must be reachable from the entry route |
| Entry event | Input that looks editable | Read-only (`aria-readonly`) | Owned by the selected provider; CTRL-179 needs a provider schema that doesn't exist yet |
| Timing | Input | A select of the timings approved for that flow | A draft outside the list is refused, so source text never sets a delay (CTRL-180) |
| Message template | Input | An editable template name, plus a Preview template link in the context line with synthetic content | CTRL-181. A preview can't send |
| Mandatory policies | Checked checkboxes | The same, read-only, with a visible reason beneath (about 36px) | CTRL-182 and its eight siblings; the explanation must be visible |
| Sandbox tests | Four outcome badges | The same, with a sentence saying they are expected outcomes and no test has run | Nothing here has been tested |
| Save draft | A button | Saves a new version through the adapter; says it doesn't enable, publish or send | FHC-04 |
| Review exclusions | Button | Moves focus to the exclusions table | CTRL has no target, so the section is the target |
| Support queue | Button | Links to `/support/cases/demo-case-1`, a placeholder owned by THO-302 | No queue route exists in the manifest |
| Overview in the primary nav | Highlighted on every lifecycle screen | The same: the `customers` section now belongs to Overview, not Operations | Matches Figma |
| Three flow pages' height | 1302 | 1378 | The policy note, plus the demo footnote |

## Recovery state gallery comparison (source 12:534)

Owner THO-306, a development-only reference. Same capture settings and method as the settings comparison above.

| Source | Route | Size | Pixels different |
| -- | -- | -- | -- |
| 12:534 | `/design-system/states` | 1520 tall, not 1478 (development footnote) | 0.305%, over the whole shared 1440px |

## Recovery state gallery mapping and differences

| Figma | Code | Notes |
| -- | -- | -- |
| State / Loading, First use, No results, Refresh failed, Stale data, Access denied, Source changed, Uncertain outcome, Sign-in required, Confirmation, Success, Validation (12:561 to 12:646) | `StatePanel` (`src/components/StatePanel.tsx`) in `StateGalleryPage` | A badge names the state, so color never carries it alone. Loading placeholders are `LoadingBones` |

| Item | Figma | Code | Why |
| -- | -- | -- | -- |
| Loading button | A gray disabled "Loading…" | The same, `aria-disabled` and described by a hidden status line; the card has `aria-busy` | CTRL-217: busy, blocked, no duplicate submission |
| Retry disabled | A gray disabled button | The same, focusable, with the uncertain-outcome sentence as its description | CTRL-218: visible reason, and reconciliation is the next step |
| Keep task | A button | Dismisses the confirmation and says nothing was canceled | CTRL-177: no transition, approval or write |
| Clear filters, Take over browser | Buttons | Dialogs describing what the control does on a real screen | There is nothing to clear and no session here |
| Other actions | Buttons | Links to the screen that owns the recovery (connections, a failed run, an approval, a receipt, launch control) | FE14-04: a logical destination |
| Development footnote | None | "Development reference · these are examples of patterns, not live states" | The cards aren't real states |
| `/design-system/states` in the nav | Automations highlighted | The same | Matches Figma; the route stays out of the menu |

## Mobile and tablet Operations (12:653, 12:708)

The native 390 and 1024 Operations designs are built with `/operations` under THO-301 (see "Operations comparison" below), not under THO-306. The shell part is still open: both designs collapse the navigation ("Menu" at 390, "More" at 1024), which would change how every screen is reached on narrow screens, and several existing browser tests click the primary navigation at 390. It needs Kevon's decision, so the shell still wraps, and the Operations comparison below attributes most of its remaining difference to that.

`e2e/responsive.spec.ts` checks the screens built under THO-304, THO-305 and THO-306 at 390, 720 (200% zoom of 1440), 768, 1024 and 1920px for page overflow, a visible H1, and a table that scrolls inside a labeled region.

## Launch and analytics comparison (sources 3:6, 14:74, 14:377, 30:349, 30:550, 30:721)

Same capture settings as Overview, from Thomas's copy of the file (see `figma-access-gap.md`), measured 2026-11-03 at threshold 0.1 with the Inter fonts loaded. Every page size matches exactly.

The measured table is in "Measured comparison, first half of the screens" above.

What remains is text and edge antialiasing, plus the differences listed below. A person hasn't yet checked the diff images. Run the comparison with a dev server that can read the fonts: if the `node_modules` symlink points outside the worktree, Vite refuses to serve `@fontsource` files, the page falls back to a system font and every figure here doubles or worse. `e2e/analytics.spec.ts` checks each page's height, the KPI card size and the weekly chart's bar scale on every run.

## Scorecards and offer comparison (sources 37:74, 37:251, 65:634, 65:814)

Same capture settings as the analytics screens. Every page size matches exactly.

The measured table is in "Measured comparison, first half of the screens" above.

The three assessment sources share one path. The record the adapter returns picks the layout (`kind`), so the address never chooses a scoring model. The offer's remaining gap is text and form-control antialiasing, with native selects drawn with a chevron where Figma's text fields have none.

## Content monitor comparison (sources 23:73, 25:166, 25:307, 25:481)

Same capture settings as the analytics screens. Every page size matches exactly.

The measured table is in "Measured comparison, first half of the screens" above.

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
| Post performance GMV note (25:481) | One fixed sentence that GMV is retained separately | Reads the post's GMV state: a reported figure with its definition and window, unknown (not $0) for a TikTok post with none, or does not apply to an Instagram post. The net sales card says "not GMV" | FE07-05: TikTok GMV is never retained net sales, and a missing GMV must not read as zero. The demo GMV for P-001 is synthetic |
| Publishing filter | A button | A radio dialog, and a note that the demo's counts don't split by network | The demo batch isn't split by network, so no result is faked |
| Capacity filter | A button | Filters the capacity table by source | CTRL-162 requires the matching record set to recompute |
| Sample batch preview | Overlay 79:2673 | Dialog built from the same wording, with figures derived from the data | Keeps the text and numbers in step |
| Orders bubbles | Fixed sizes | Fixed sizes | Matches Figma, but sizes aren't data-driven; the labels carry the values |
| Blocked-action reasons (evidence) | Disabled Add observation and Mark watched with no reason | The reasons are listed as text under the buttons, adding 56px | CTRL-154 requires a visible reason. This is why the page is 2267 tall, not 2211 |
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
| Primary navigation on `/campaigns` | Creators section | Creators section | Matches Figma (found by the pixel diff). The lifecycle merge had moved it to Overview; `nav.ts` has it under Creators again |
| Social Cat history tabs | The note ends after "tracked independently." | A second sentence says the history tabs are read-only and no gifted-only, paid or hybrid acquisition can start | The disabled tabs' reason is visible and also the tabs' accessible description. Adds one 18px line |
| Social Cat recruitment gates | The note ends after "observed performance." | A second sentence says sample, content and rights stay locked until each one's own gate is met | Same. Adds one 18px line |
| Publishing network filter on the Social Cat dashboard | All three buttons look the same | The selected network is violet, and the buttons are `aria-pressed` | The current filter has to show. All publishing networks is selected at first |
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
| Channel route on both dashboards (23:275, 23:440) | One line of source, network, checkout and provider (Social Cat); source and publishing badges (TikTok) | Labeled parts for Source, Publishing, Checkout and Payout owner on both, and "A TikTok post is not a TikTok Shop order" on Social Cat. A "Hourly monitoring" link beside "Daily sourcing" on both dashboards and boards | FE02-03 and FE02-05: the four are different facts, and daily acquisition and hourly monitoring are different destinations. The Social Cat provider is illustrative |
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
| Posting timing on the overview | Posting due, grace period and review date for the one example | The same rows for a collaboration whose accepted terms commit a post, with a short "Due today" style suffix on the due date. A collaboration whose terms commit no post (`/collaborations/demo-collaboration-2`, no Figma frame) shows no due date, grace period or review date; it shows the observation window, the retained sample cost and an observe-then-close branch, offers no posting reminder, and has no content review | FE03-04: posting and no-post timing apply only when the accepted terms create the obligation. The demo date comes from the record (`asOf`), not the browser clock. The voluntary record is synthetic |
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
| Reports | "Awaiting close" | The same, and "Export failed: rerun pending" with an incomplete-month notice under `?scenario=exportfailed`; a report that exported reads "Exported" with its receipt (`?scenario=partialexport`) | FIN274-06: a failed export never reads as a finished package |
| Close wording and state | "Open month · 4 of 7 checks complete", Period status "Open" | Unchanged while the period really is open (the default). Every other state shows its own name: "Reconciling", "Blocked", "Awaiting CPA", "Ready to export", "Exporting", "Failed", "Closed", "Reopened". The status, CPA review, unmatched payouts, checks and report list are derived from the same evidence as the close package, under `?scenario=` | The summary and the package behind "Close package and corrections" can't disagree. Remaining differences: the checks, exceptions, CPA review and report rows change with the scenario, and the exceptions list is empty when no payout is unmatched |
| Close package and corrections, Months and revisions, Dry-run manifest | Not drawn in 7:683 | Three links inside the reconciliation dialog to `?view=package`, `?view=months` and `?view=manifest`, built from shared components with no fidelity claim. The page stays 1471px because the links sit inside the dialog | FIN274-02/03, FIN-EVIDENCE and the month-end close acceptance. They are evidence views, not controls |
| Section navigation | Buttons | Month-end and Reports go to the October close, Unit economics to Financial pulse | The manifest has no separate routes for them |
| Where $12,596 goes | Values typed | The five parts sum to the 30-day receipts, with a test | The breakdown has to reconcile |

## Shared page components

`src/components/Panels.tsx` holds the page furniture the operations, support and finance screens share: PageHeader, Panel, Notice, FactList, Steps, FlatTable and Meter. Measurements come from Figma frames such as 4:6, 4:171 and 4:317. Panels keep a 24px padding and a 1px border. Figma's content width ignores the border, but using 23px padding made the pixel difference worse, so it is left at 24.

## Implementation adaptations

Only Operations has native 390 and 1024 designs. For Overview and the shell, panels stack below 1180px, the header wraps, and the chart scrolls inside a labeled region. These are proposals to review under THO-306, not matches to a design.
