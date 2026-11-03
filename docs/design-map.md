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
