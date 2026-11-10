# Sandbox simulation (dev only)

`npm run sim` runs the dashboard locally the way the agent browser tests do, with every domain connected at once:

- **Agent** (`tools/sandbox-sim/agent.ts`, port 4401): the real `createAgentServer` in sandbox mode, `loadApprovedBindings()`, and `loadCreatorSourceRuntime` with an empty provider environment, so no real source is ever contacted. Every source is a synthetic fixture already used by an `e2e-agent/*.spec.ts` or `src/creator-agent/**/*.testkit.ts`. No new fake data was written. The scope is `synthetic-workspace` / `synthetic-account`. Each run starts a fresh SQLite database at `.agent-data/sim/agent.sqlite` and generates new random reader and reviewer tokens.
- **Dashboard** (`tools/sandbox-sim/run.mjs`, port 4400): `vite build` with `VITE_FARDA_ADAPTER=sandbox` and `VITE_FARDA_ADAPTER_BASE_URL=http://127.0.0.1:4400`, then `vite preview` with `FARDA_AGENT_PROXY_TARGET` pointing at the agent. This is the same setup as `playwright.agent.config.ts`.

To change the ports, set `FARDA_SIM_APP_PORT` and `FARDA_SIM_AGENT_PORT`. Set `FARDA_SIM_SKIP_BUILD=1` to reuse the last build in `.agent-data/sim/dist`. `FARDA_SIM_REFRESH_MS` shortens the 3-minute rebuild cycle (minimum 10 seconds) for testing. Ctrl-C stops both servers. `.claude/launch.json` has a `farda-sim` entry for the desktop preview.

## Sign-in

The server is unchanged, so it accepts only its two existing sign-in paths.

- **Reader in your own browser.** Open `http://127.0.0.1:4400/v1/session`. Use `127.0.0.1`, not `localhost`, because the cookie is host-only. At the "Farda agent reader" prompt, enter user name `reader` and the reader token that the launcher prints. Then open `/overview`. Sessions last one hour.
- **Reviewer or reader in a launched browser.** Run `npm run sim -- --open=reviewer` (or `--open`). Playwright Chromium signs in with the bearer token, exactly as the specs do, and opens `/overview`. Reviewer sessions are needed for saves and approvals. Set `E2E_AGENT_BROWSER_CHANNEL=chrome` to use the installed Chrome.
- **Scripts.** Both tokens are in `.agent-data/sim/session.json`, which is gitignored and mode 600.

## Clock

The server uses the real clock, and fixtures are re-timed to now. Nothing is frozen, so leases checked against the browser's own clock stay valid.

- **Fixtures that take a time** are rebuilt at the current time every 3 minutes: overview owners, sourcing, and lifecycle. A read and its `assertCurrent` that straddle a rebuild are checked against the previous generation. Sourcing and lifecycle get a new source version for each generation, because the server persists facts per version. Overview owners seeds intake and the portfolio review into the server database only once. Later generations link to those stored records. On a new UTC day, the new review window is stored through `PortfolioRepository`.
- **Fixtures with fixed module-level times** (finance detail, operations, team, controls, stock and support, collaboration) run in their own time frame. Every instant is shifted forward by `now - <fixture test time>`, floored to the minute and re-anchored every 3 minutes. Calendar dates move by whole days, which is what `shippingHubSourceFixture` already does. Requests are shifted back into the frame, so the ages the tests assert are kept.
- **The settlement ledger** is built once at launch, because the server keeps paid receipts immutable by reference. Only its access grant slides to now. Its facts stay current for the reader's 24-hour age limit, so restart the simulation after a day.
- **Lease extensions** copy the specs: shipping hub, sourcing and controls leases are 10 minutes.

If a page stays open past its lease, it shows the honest expired state. Reload it to read again.

## Screens and sources

| Screen | Source (fixture) |
| -- | -- |
| `/overview`, `/analytics/attribution`, paid media, `/launch` | `overviewOwnersFixture` (analytics, finance dashboard, period-scoped operations, monitor, intake, portfolio), plus `addReservationFixture` and `addNativeReviewEvidence` (paid media only) |
| `/finance`, `/analytics/finance` | Overview owners' finance dashboard record |
| Finance close, payable and detail views | `financeSnapshot` (`finance-reads.spec.ts`) |
| `/finance/commissions`, settlements, payables | `originalLayoutFinanceSource` (settlement ledger) |
| `/operations` and order, shipment and return details | `originalLayoutOperationsSource`. Requests that carry a period go to overview owners |
| `/inventory`, support | `inventorySourceFixture` / `supportSourceFixture` |
| `/settings/team`, `/automations`, `/launch` controls | `controlSourceFixture` (with `controlTestJob` registered) and `teamInvitationSnapshot` |
| `/creators/discovery`, plan view | `nativeSourcingSourceFixture` + `sourcingSourceFixture`, and one saved assessment (`syntheticAgentEvidence` under the approved website model) |
| `/content`, `/creators/watchlist` | Overview owners' monitor + intake |
| `/customers/lifecycle` and flows | `lifecycleSourceFixture` |
| Shipping hub | `shippingHubSourceFixture` (full demo set) |
| `/collaborations/synthetic-collaboration` | `collaborationSnapshot` |

**Conflicts.** Overview owners was chosen over the single-domain analytics, finance dashboard, operations overview and monitor fixtures, because only it reconciles all five overview domains in one period. The richer original-layout operations facts serve the screens that request no period. `monitor-evidence.spec.ts` (full watchlist) and `overview-owners.spec.ts` (shipping hub narrowed to one row) are the unused alternatives.

## Known gaps

- `/approvals` is still a placeholder screen. Approval detail, recruitment workspaces, bulk, media, runtime, fulfillment and settlement actions need `actionFoundation`. Their fixtures (`approvalFixture`, `recruitmentServerFixture`, `bulkServerFixture`) bring their own manual clocks and databases, so they are not wired in.
- `/analytics/customer-journey` shows the pending traffic owner. `siteTrafficServerFixture` has fixed partition dates and its own scope, and it needs a machine import.
- `/creators/pipeline` is empty: no funnel events are seeded. Asset registry, provider health and the portfolio authority are unconfigured.
- `/operations` shows "Some data is missing" (6 of 18 rows), and the sourcing plan covers 35 of 45 rows. Both fixtures are partial by design.
