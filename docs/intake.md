# Repository intake

Required by section 1 of the handoff and THO-292 FHC-04. Base revision: `75b98ae`, intake taken 2026-11-03.

## Stack

| Item | Value |
| -- | -- |
| App directory | repository root |
| Runtime | Node 22 or later (`engines`), tested locally on 24.21.0; CI uses 22 |
| Package manager | npm, with `package-lock.json` |
| Framework | React 18, Vite 5, TypeScript 5 in strict mode |
| Routing | React Router 6, data router built from the generated manifest |
| Data | TanStack Query 5 over the adapter seam; Zod for contract schemas |
| Styling | CSS custom properties from Figma tokens, and CSS modules |
| Font | `@fontsource/inter` 4.5.15, pinned (see `design-map.md`) |
| Tests | Vitest and Testing Library; Playwright and axe |
| Auth | None yet. Demo scope is fixed; live scope comes from THO-283 |

## Commands

| Purpose | Command |
| -- | -- |
| Install | `npm ci` |
| Dev server (port 5173) | `npm run dev` |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Unit and contract tests | `npm test` |
| Production build | `npm run build` |
| All of the above | `npm run verify` |
| Browser tests (first run `npx playwright install chromium`) | `npm run test:e2e` |
| Regenerate routes | `npm run manifest:generate` |

## Environment variables

| Name | Purpose |
| -- | -- |
| `VITE_FARDA_ADAPTER` | `demo` (default), `sandbox` or `production`. Anything else is a startup error |
| `VITE_FARDA_ADAPTER_BASE_URL` | Reserved for the THO-283 adapter. Unused until its transport is published |

`VITE_` values ship to the browser, so they never hold secrets.

## Route decisions

Proposed paths from handoff section 6 are used as written. Sources that share a path are selected by query value or returned record state. `/design-system/states` is routable but left out of primary navigation because it is a development surface.

Approval history has no proposed path, so it uses query values on the approval route: `/approvals/:approvalId?view=history` and `?version=vN`. `/approvals` and `/runs` aren't Figma sources. In demo they list the labeled scenarios; otherwise they show the section index.

## Open inputs

- Figma: a copy works; the original still refuses this account. See `figma-access-gap.md`.
- THO-283 has not published a transport, so the contract in `src/adapter/contract.ts` stays proposed.
- Approval and run view models in `src/features/approvals/types.ts` are proposals. THO-283 and THO-321 freeze the real schemas.

## Questions for the THO-283 freeze

Raised by the approval flow:

- `ActionResponse.state` has no value for "approved, awaiting dispatch". The demo returns `blocked` with `AWAITING_DISPATCH`.
- The error catalogue has no not-found code. The demo uses `RECORD_NOT_FOUND`.
- `ActionRequest` has no run reference for `controlRun` and `reconcileRun`. The demo puts `runRef` in the payload.
- `executionCertainty` has no defined values. The demo uses `notApplied`, `uncertain` and `applied`.
