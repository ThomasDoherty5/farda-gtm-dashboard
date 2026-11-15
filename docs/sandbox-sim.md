# Sandbox simulation (dev only)

## Run it locally

1. **Prerequisites.** Node 22 or later (`engines` in `package.json`), and `npm ci` once. The `--open` flag and `npm run sim:smoke` also need a Playwright browser: run `npx playwright install chromium`, or set `E2E_AGENT_BROWSER_CHANNEL=chrome` to use the installed Chrome.
2. **Start it.** Run `npm run sim`. The first start builds the dashboard, which takes about a minute. The terminal then prints the URLs and a reader token.
3. **Open it.** Go to `http://127.0.0.1:4400/v1/session`. Use `127.0.0.1`, not `localhost`. At the "Farda agent reader" prompt, enter user name `reader` and the printed token. Then open `http://127.0.0.1:4400/overview`. In the desktop app, the `farda-sim` entry in `.claude/launch.json` opens the same URL in the browser pane.
4. **Switch role.** The reader can browse every screen. Saves and approvals need the reviewer, which has no password prompt. Stop the simulation and run `npm run sim -- --open=reviewer`, which opens a signed-in browser. Use `--open` for a signed-in reader.
5. **Reset data.** Stop and start again. Every run deletes `.agent-data/sim/agent.sqlite` and issues new tokens. `FARDA_SIM_SKIP_BUILD=1 npm run sim` skips the rebuild when the last build was for the same port.
6. **Stop it.** Press Ctrl-C. This stops the agent and the preview server, and the ports are freed.

**Checks.** `npm run sim:smoke` starts a separate simulation on free ports with its own data in `.agent-data/sim/smoke`, so a running simulation is untouched. It checks the agent's health, the dashboard page, reader and reviewer sign-in and a `/v1/read` through the preview proxy, and it loads six screens headless. Then it stops everything. The repository's own suites do not use the simulation, and they can run while it is up. `npm run verify` runs typecheck, lint, unit tests and the build. `npm run test:e2e` serves the fixture build on port 4173. `npm run test:e2e:agent` starts its own agent and preview on free ports, with the same fixtures the simulation uses.

## How it works

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
- **Mirror runs** are recorded relative to the launch time, as in `mirror-freshness.spec.ts`: orders and shipments 10 minutes ago, stock 90 minutes ago (stale), and partial support, failed finance and revoked content 5 minutes ago. Collaborations has never synced. New orders and shipments runs complete on every refresh cycle, so those two stay current, and the others age the way a real stalled mirror would.
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
| `/settings/connections` mirror freshness | `mirrorTestSource` with `mirrorTestBindings` and `mirrorTestApproval` (approval re-dated to yesterday). The six runs of `mirror-freshness.spec.ts` are recorded at start, and the server's own 15-minute sweep runs (`deploymentRef: sandbox-sim`) |

**Conflicts.** Overview owners was chosen over the single-domain analytics, finance dashboard, operations overview and monitor fixtures, because only it reconciles all five overview domains in one period. The richer original-layout operations facts serve the screens that request no period. `monitor-evidence.spec.ts` (full watchlist) and `overview-owners.spec.ts` (shipping hub narrowed to one row) are the unused alternatives.

## Known gaps

- `/approvals` is still a placeholder screen. Approval detail, recruitment workspaces, bulk, media, runtime, fulfillment and settlement actions need `actionFoundation`. Their fixtures (`approvalFixture`, `recruitmentServerFixture`, `bulkServerFixture`) bring their own manual clocks and databases, so they are not wired in.
- The weekly KPI trend on `/analytics/attribution` (`overview-analytics.spec.ts`) is not shown. `weeklySnapshotFixture` needs the reporting part of `actionFoundation`, and it runs its own server on a fixed November 2026 clock.
- `/analytics/customer-journey` shows the pending traffic owner. `siteTrafficServerFixture` has fixed partition dates and its own scope, and it needs a machine import.
- `/creators/pipeline` is empty: no funnel events are seeded. Asset registry, provider health and the portfolio authority are unconfigured.
- `/operations` shows "Some data is missing" (6 of 18 rows), and the sourcing plan covers 35 of 45 rows. Both fixtures are partial by design.
