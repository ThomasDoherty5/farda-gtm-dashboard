# Repository intake

Required by section 1 of the handoff and THO-292 FHC-04. Original intake: `75b98ae`, November 3. Runtime status refreshed November 6 after the native agent service and saved-operations releases.

## Stack

| Item | Value |
| -- | -- |
| App directory | repository root |
| Runtime | Node 24 for the native SQLite service and CI; frontend package engine permits 22 or later |
| Package manager | npm, with `package-lock.json` |
| Framework | React 18, Vite 5, TypeScript 5 in strict mode |
| Routing | React Router 6, data router built from the generated manifest |
| Data | TanStack Query 5 over the adapter seam; Zod for contract schemas |
| Styling | CSS custom properties from Figma tokens, and CSS modules |
| Font | `@fontsource/inter` 4.5.15, pinned (see `design-map.md`) |
| Tests | Vitest and Testing Library; Playwright and axe |
| Auth | Demo scope is fixed and separate. Native server issues scoped reader/reviewer sessions, with origin/CSRF checks on cookie-authorized mutations. Machine credentials remain server-side. The reference server is a separate test double. |

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
| `VITE_FARDA_ADAPTER_BASE_URL` | Where the HTTP transport (`src/adapter/httpTransport.ts`) sends requests; paths are in `docs/adapter-decisions.md`. Used only when `VITE_FARDA_ADAPTER` is `sandbox` or `production`. With no value it answers `INTEGRATION_PENDING`. Must be https, or http for localhost. The native agent service supports its published sandbox views; unsupported sources remain pending and never fall back to fixtures. |

`VITE_` values ship to the browser, so they never hold secrets.

## Route decisions

Proposed paths from handoff section 6 are used as written. Sources that share a path are selected by query value or returned record state. `/design-system/states` is routable but left out of primary navigation because it is a development surface.

Approval history has no proposed path, so it uses query values on the approval route: `/approvals/:approvalId?view=history` and `?version=vN`. `/approvals` and `/runs` aren't Figma sources. In demo they list the labeled scenarios; otherwise they show the section index.

## Open inputs

- Original Figma access has been verified for the shared-shell release. Exact source frames must still be re-read for each changed screen; see `figma-access-gap.md`.
- Native sandbox API reads, durable saves and source-bound modules are implemented in `src/creator-agent/server.ts`; the schema identifier remains `2026-11-02.proposed` for compatibility. This does not mean every dashboard view or provider is connected. See the module API documentation and Linear for each tested release stage.
- Approval and run view models in `src/features/approvals/types.ts` remain frontend proposals until their native J04 decision/dispatch paths are bound. A saved draft, local proposal or source observation does not authorize execution.

## Questions for the THO-283 freeze

The full register of view keys, action kinds, error codes and open questions is `docs/adapter-freeze-register.md`; a test keeps it in step with the source. The questions below are the ones the approval flow raised first.

Raised by the approval flow, and answered on 2026-11-04 in `docs/adapter-decisions.md` (defaults for the build, not a ruling over the backend owner; nothing is verified against a service):

- Q-01: `ActionResponse.state` has `approved` (awaiting dispatch). It is not a success state, and the approval screens say "Approved, awaiting dispatch".
- Q-02: `RECORD_NOT_FOUND` is a not-found code, returned only inside the verified scope.
- Q-03: `ActionRequest` has an optional top-level `runRef`, used by `controlRun` and `reconcileRun` instead of the payload.
- Q-04: `executionCertainty` is `notApplied`, `uncertain` or `applied`, and is required on every write error, action answer and save answer.
- D-13: each `sourceFreshness` entry may carry `freshnessState`; the client falls back to the reason-code mapping when it is absent.
