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
| Auth | None yet in the app. Demo scope is fixed; live scope comes from THO-283. The reference server has a fake dev sign-in only |

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
| Reference server, a test double on 127.0.0.1 (see `tools/reference-server/README.md`) | `npm run reference-server` |
| Browser test against the reference server (starts and stops it; not part of `verify` or `test:e2e`) | `npm run test:e2e:reference` |

## Environment variables

| Name | Purpose |
| -- | -- |
| `VITE_FARDA_ADAPTER` | `demo` (default), `sandbox` or `production`. Anything else is a startup error |
| `VITE_FARDA_ADAPTER_BASE_URL` | Where the HTTP transport (`src/adapter/httpTransport.ts`) sends requests; paths are in `docs/adapter-decisions.md`. Used only when `VITE_FARDA_ADAPTER` is `sandbox` or `production`. With no value the live adapter keeps its pending transport and answers `INTEGRATION_PENDING`. Must be https, or http for localhost. No production backend exists, so the only server that answers is the reference server |

`VITE_` values ship to the browser, so they never hold secrets.

## Route decisions

Proposed paths from handoff section 6 are used as written. Sources that share a path are selected by query value or returned record state. `/design-system/states` is routable but left out of primary navigation because it is a development surface.

Approval history has no proposed path, so it uses query values on the approval route: `/approvals/:approvalId?view=history` and `?version=vN`. `/approvals` and `/runs` aren't Figma sources. In demo they list the labeled scenarios; otherwise they show the section index.

## Open inputs

- Figma: a copy works; the original still refuses this account. See `figma-access-gap.md`.
- THO-283 has not published a transport, so the contract in `src/adapter/contract.ts` stays proposed. The live adapter's front-end half is in `live-adapter.md`; with no transport it still answers `INTEGRATION_PENDING`.
- Approval and run view models in `src/features/approvals/types.ts` are proposals. THO-283 and THO-321 freeze the real schemas.

## Questions for the THO-283 freeze

The full register of view keys, action kinds, error codes and open questions is `docs/adapter-freeze-register.md`; a test keeps it in step with the source. The questions below are the ones the approval flow raised first.

Raised by the approval flow, and answered on 2026-11-04 in `docs/adapter-decisions.md` (defaults for the build, not a ruling over the backend owner; nothing is verified against a service):

- Q-01: `ActionResponse.state` has `approved` (awaiting dispatch). It is not a success state, and the approval screens say "Approved, awaiting dispatch".
- Q-02: `RECORD_NOT_FOUND` is a not-found code, returned only inside the verified scope.
- Q-03: `ActionRequest` has an optional top-level `runRef`, used by `controlRun` and `reconcileRun` instead of the payload.
- Q-04: `executionCertainty` is `notApplied`, `uncertain` or `applied`, and is required on every write error, action answer and save answer.
- D-13: each `sourceFreshness` entry may carry `freshnessState`; the client falls back to the reason-code mapping when it is absent.
