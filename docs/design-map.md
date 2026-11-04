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

## Mobile and tablet Operations (12:653, 12:708): not built

The native 390 and 1024 designs belong to `/operations`, which THO-301 owns in another session, so they are not built here. Two parts do not need that page, and neither is built either:

- **Shell.** Both designs collapse the shell: at 390 the navigation is replaced by a "Menu" button, and at 1024 it ends in "More". Doing that changes how every screen is reached on narrow screens, and several existing browser tests click the primary navigation at 390. It needs Kevon's decision and a pass over those tests, so it is left as the current wrapping header (an implementation adaptation noted above).
- **Content.** The mobile layout stacks KPI cards two across, "Ship next" cards each ending in "View source record", a stock warning card with "View transfer", and a refresh footnote. The tablet layout is a three-card KPI row, a table, and a stock and exceptions pair.

`e2e/responsive.spec.ts` checks the screens built under THO-304, THO-305 and THO-306 at 390, 720 (200% zoom of 1440), 768, 1024 and 1920px for page overflow, a visible H1, and a table that scrolls inside a labeled region.

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

## Implementation adaptations

Only Operations has native 390 and 1024 designs. For Overview and the shell, panels stack below 1180px, the header wraps, and the chart scrolls inside a labeled region. These are proposals to review under THO-306, not matches to a design.
