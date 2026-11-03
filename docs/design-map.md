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
| Input | 6:404 | 5 | Not built | Pending |
| Search | 6:414 | 3 | Not built | Pending |
| Tab | 6:424 | 3 | Not built | Pending |
| Checkbox | 6:443 | 4 | Not built | Pending |
| Toggle | 6:459 | 3 | Not built | Pending |
| Source freshness | 6:500 | 5 | Not built | Pending |
| KPI card | 6:516 | 3 | Overview `card` styles | Overview uses its own instances; set not read yet |
| Table cell | 6:528 | 3 | Not built | Pending |
| Table row | 6:557 | 4 | Not built | Pending |
| Table header | 6:564 | 1 | Not built | Pending |
| Step | 6:595 | 5 | Not built | Pending |
| Lifecycle/Step | 5:3 | Not counted in the 21 | `Step` in `RunPage` | Built from instances in 5:13 and 5:156 |
| Drawer | 6:703 | 1 | Not built | Pending |
| Toast | 6:710 | 2 | Not built | Pending |
| Tooltip | 6:714 | 1 | Not built | Pending |

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
| Orders bubbles | Fixed sizes | Fixed sizes | Matches Figma, but sizes aren't data-driven; the labels carry the values |

## Implementation adaptations

Only Operations has native 390 and 1024 designs. For Overview and the shell, panels stack below 1180px, the header wraps, and the chart scrolls inside a labeled region. These are proposals to review under THO-306, not matches to a design.
