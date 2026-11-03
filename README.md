# Farda GTM dashboard (frontend)

This is the frontend for the Farda GTM operations dashboard. It is built from Kevon's Linear handoff, "Farda frontend — scoped Figma-to-code handoff" (revised 2026-11-02), and these companion documents:

- control behavior and state contracts
- adapter contracts, fixtures and verification

## Status: work in progress (phase 1 foundation)

**Done**
- Vite, React, TypeScript and React Query scaffold, with strict TypeScript, ESLint, Vitest and Playwright configured.
- A typed adapter seam (`src/adapter/`), transcribed from the adapter document, sections 2–5. Its status is *proposed*; THO-283 freezes it.
  - Zod schemas for the contract types.
  - Error-category mapping.
  - A demo adapter. It uses a frozen clock, never dispatches, and every capability reports `unverified`.
  - A live adapter stub. It fails with `INTEGRATION_PENDING` and never falls back to demo data.
- `useView`, which scopes query keys and aborts stale requests. It rejects a response whose scope doesn't match the request.
- A scope provider that clears cached data when the scope changes.
- Overview fixtures FX-01 to FX-09, from the dataset "overview-original": 400 orders / $12,596; 5 posts, 240k views, 5.0% engagement; 180 attributed orders / $5,796. Select one with `?fixture=FX-04`, for example.
- 60-source route manifest:
  - `docs/figma-source-manifest.md` is copied verbatim from the handoff.
  - `npm run manifest:generate` builds `src/routes/manifest.generated.ts` from it.
  - Every route renders. Unbuilt routes show an honest placeholder that names the owner issue and the Figma source node.
- The shell has a skip link, horizontal navigation, a main landmark and a demo banner that is always visible.
- Button behavior: loading, and disabled with a reason.
- Overview data slice (`/overview`, source 10:217):
  - six metrics with provenance
  - known zero is distinct from N/A
  - stale, partial, empty and error states

- Unit and contract tests (`src/**/*.test.ts(x)`), Playwright smoke and axe tests (`e2e/`), and a CI workflow.
- `AGENTS.md`, `docs/intake.md` and `docs/figma-access-gap.md`.

- Approval flow behavior (THO-296): approval detail and history, agent run approval and unknown-outcome recovery, on an in-memory demo state machine covering FX-10 to FX-18. Start at `/approvals` or `/runs`. Demo state resets on reload. It is unstyled, and its Figma comparison hasn't happened.

**Not done yet**
- **All visual design.** Colors, spacing, radii and component visuals are deliberately system defaults. Figma access is blocked; see `docs/figma-access-gap.md` for what unblocks it and what to do first.
- **The rest of THO-296:** real Slack handoff, login/MFA and denied-permission run states, and the separate provider settlement dialogs. `saveResource` is typed, but nothing uses it yet.
- **Overview filters and charts**, which need the Figma source.
- **The other 59 sources.** They render labeled placeholders.

## Commands

```
npm install
npm run dev          # http://localhost:5173 (demo adapter)
npm run verify       # typecheck + lint + unit tests + build
npm run test:e2e
npm run manifest:generate
```

## Rules carried from the handoff
- Never put secrets in the client, URLs or browser storage.
- No live dispatch from demo.
- Demo data is always labeled, and the app never silently falls back to it.
- Accessibility targets WCAG 2.2 AA. Test at widths 390, 768, 1024, 1440 and 1920, at 200% zoom, and with 320px reflow.
- Make no fidelity claims without a Figma comparison.
