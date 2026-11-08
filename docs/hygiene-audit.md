# Hygiene audit

Audited 2026-11-04 against `origin/main` at `2f0c24d` (94 commits, one branch, no tags). Stage: fixture-complete. This document contains no secrets or personal data.

## Verdict

No secrets, tokens, real-looking contact details, exported Figma captures or pasted Linear issue text were found in the working tree or in history. Four judgment calls are listed under "For the owner".

## 1. Secrets and personal data

What was checked, over the working tree and every commit reachable from any ref (`git grep` across `git rev-list --all`, plus `git log -p -G`):

| Check | Result |
| -- | -- |
| Token and key patterns: AWS, GitHub (`ghp_`, `github_pat_`), `sk-`, Slack, Google `AIza`, Stripe, Shopify (`shpat_`), JWT, PEM blocks, `Bearer <long>` | No matches in any revision |
| Email addresses, whole history | Only a fake `user:pw@www.instagram.com` URL in `src/features/acquisition/evidenceRules.test.ts`, a test input for the "login details in a URL" rule. Not a real credential |
| Phone numbers | None |
| Binary or capture files (png, jpg, svg, pdf, json, csv, xlsx, fig) | None tracked now; none ever added (`git log --all -- '*.png' '*.jpg' '*.svg'` is empty). Only deleted files in history: `e2e/zz-diag.spec.ts` and `src/components/DemoBanner.tsx`, both code |
| `.env` files | Only `.env.example`, which holds `VITE_FARDA_ADAPTER=demo` and an empty base URL. `.env*` and `.handoff/` are gitignored and were never committed |
| Provider identifiers (store, account, shop ids; long numeric ids) | None. "Shopify", "Shippo" and "Notion" appear only as labels in fixtures, tests and docs |
| Pasted Linear text | None. `docs/` holds ticket ids and issue-title slugs in links, not issue bodies |
| GitHub `run_secret_scanning` | Unavailable: the repository has no GitHub Advanced Security. I used the regex checks above instead, so this is not a substitute for push protection |

### For the owner (judgment calls, nothing changed)

1. **Creator handles in fixtures.** `src/fixtures/*.ts` and tests use handles such as `@studio.rae` and `@dailywithjo`; two (`@itsmarisol`, `@thegoodroutine`) in `src/fixtures/creators.ts` read like they could be real accounts. The fixtures are labeled synthetic, but I can't verify the handles are invented without probing social networks. Please confirm they came from the design and name no real person, or rename them.
2. **Original Figma file key** `UkX7Vy6r5BGgYvUCAi6Pmd` appears in `docs/figma-access-gap.md`, `docs/figma-source-manifest.md`, `scripts/generate-route-manifest.mjs` and `src/routes/manifest.generated.ts`. The copy key `z9knjMdQ3kxL6Fblvu1tKc` in docs is the sanctioned one. The original key is a file identifier, not a credential (the file refuses access), and the generator needs it, so I left it. Decide whether a public repo should name the private original.
3. **Linear workspace slug and issue-title slugs.** `docs/figma-source-manifest.md` (61 links) and `src/routes/RoutePlaceholder.tsx` link to `linear.app/thomas-doherty/issue/THO-…/<title-slug>`. This discloses the workspace name and issue titles, not issue text. Ticket ids are allowed by the task; consider whether the slugs should stay.
4. **Author email in history.** Commit `75b98ae` carries a personal Gmail address as author metadata (the other 93 commits use a GitHub noreply address). Removing it needs a history rewrite and force-push, which I did not do. If it matters, rewrite with `git filter-repo --mailmap` and force-push `main` deliberately.

## 2. Dependencies

Before: `npm audit` reported 20 vulnerabilities (1 low, 12 moderate, 5 high, 2 critical); 4 high in production dependencies.
After: 20 (2 critical, 2 high, 16 moderate); production: 3 (1 high `zod`, 2 moderate). The `react-router-dom`/`@remix-run/router` and `vite` high advisories are cleared; the count stays flat because the rest need major bumps (below), and the newer ESLint/typescript-eslint tree reports more moderate dev-only findings. Rerun `npm audit` for the live list.

Applied (exact pins kept, lockfile in sync, within the current major): `react-router-dom` 6.28.0→6.30.6, `@tanstack/react-query` 5.59.20→5.105.3, `vite` 5.4.11→5.4.21, `vitest` 2.1.5→2.1.9, `eslint` and `@eslint/js` 9.14.0→9.39.5, `typescript-eslint` 8.14.0→8.72.1, `eslint-plugin-react-hooks` 5.0.0→5.2.0, `typescript` 5.6.3→5.9.3, `@testing-library/react` 16.0.1→16.3.3, `user-event` 14.5.2→14.6.8, `jest-dom` 6.6.3→6.10.0, `@types/react` 18.3.12→18.3.31, `@types/react-dom` 18.3.1→18.3.7, `@vitejs/plugin-react` 4.3.3→4.7.0, `globals` 15.12.0→15.15.0, `@types/node` ^22.9.0→^22.20.5.

Not applied:

| Package | Reason |
| -- | -- |
| `@axe-core/playwright` 4.10.1 (4.14.0 available) | **Finding, partly fixed.** 4.14.0 adds a check that failed seven stock-and-support e2e tests with `label-content-name-mismatch` on the profile control (`._profile_*` in the shell). Fixed on 2026-11-08: its accessible name now starts with the visible initials (`TD, open workspace menu` in demo), with no visual change. With 4.14.0 installed, `stock-support.spec.ts`, `shell-accessibility.spec.ts`, `keyboard-all.spec.ts` and `responsive-all.spec.ts` passed, but `a11y-all.spec.ts` still failed 3 tests with the same rule on the weekly receipt buttons of `/analytics/attribution` (`._weekButton_*`). Their `aria-label` reads "Wk 4: Shopify $2,600, TikTok Shop $1,300" while the visible text is "$2,600 $1,300 Wk 4", and the rule needs the visible words in the same order inside the name. Fixing that means deciding how the chart reads to a screen reader (where the channel names go), so it was not changed here. Still held at 4.10.1; fix the week buttons, then bump |
| `@fontsource/inter` 4.5.15 | Pinned on purpose (`docs/design-map.md`) |
| `@playwright/test` 1.63.0 (1.64.1) | Held: the browser build must match the installed Chromium; bump with a browser refresh |
| `zod` 3.23.8 → 4.6.7 | Major. Fixes GHSA-mrhx-c7xc-m3w5 (memory exhaustion on oversized constrained collections). Real for any client that validates untrusted payloads; needs a migration |
| `vitest` 2 → 5, `vite` 5 → 8, `@vitejs/plugin-react` → 6 | Majors. Clears the remaining critical `tinypool` and moderate `esbuild` advisories, which are dev-server and test-runner only (not shipped to browsers) |
| `eslint` 10, `typescript` 7, `react`/`react-dom` 19, `react-router-dom` 7, `jsdom` 30, `pixelmatch` 8, `@types/*` 19/26 | Majors; separate migration work |

The remaining dev-only advisories (`tinypool`, `esbuild`, `minimatch` via typescript-eslint, `@vitest/mocker`) do not reach the production bundle.

## 3. Workflows (`.github/workflows/ci.yml`)

Already good: `permissions: contents: read`, no secrets, no `pull_request_target`, no inline expression injection, `npm ci` from the lockfile.

Changed: `persist-credentials: false` on checkout, `timeout-minutes: 30`, and a `concurrency` group that cancels superseded runs. Added `.github/dependabot.yml` (weekly, GitHub Actions and npm, `@fontsource/inter` ignored) so action and dependency drift surfaces as reviewable PRs.

Not changed, recommended:

- **Pin actions to full commit SHAs** (`actions/checkout@v4`, `setup-node@v4`, `upload-artifact@v4` are mutable tags). I could not resolve the SHAs from this session, and guessing them would be worse than tags. Dependabot will keep SHA pins updated once they are set.
- `npx playwright install --with-deps chromium` runs apt as root on the runner; acceptable on a hosted runner, but consider a pinned Playwright container image.
- Enable branch protection on `main` requiring the `verify` check, GitHub secret scanning with push protection, and Dependabot security alerts (all repository settings, not code).

## Verification

`npm run verify` (typecheck, lint, 786 unit tests, build) and `npm run test:e2e` (520 passed, 66 skipped by project) pass before and after the changes.
