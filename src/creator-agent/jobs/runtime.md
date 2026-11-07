# Registered job runtime

`JobRuntime` composes the existing scoped `JobRepository`, `CapabilityLedger`, saved schedule drafts and optional `DispatchGuard`. The server supplies compiled, versioned registrations, executor implementations, machine authorization and current source authority. The strict fire/work/catch-up/takeover inputs cannot supply endpoints, handlers, source items, capabilities, policy, credentials or an enable/Ready flag. Missing source authority remains unconnected.

`registered-source.v1` is reserved for this runtime and excluded from the old local `processOne` worker. Legacy registration, ingress, read and control APIs must also exclude it. The new `job_runtime_*` tables contain registration, source-window, observation, takeover and measurement records linked to the existing runs/items. They are not another queue, scheduler, financial balance or quota issuer.

## Cadence and admission

Daily discovery and daily video review have distinct registrations, job IDs, budgets and checkpoints. Hourly monitoring requires enrolled-only membership, rechecked before source calls and final commits. Calendar activation pins the exact current saved draft/job revision and normalized body. Editing that draft holds the old activation. Hourly cadence is explicit. Missing daily local time advances to the first valid wall minute; daily repeated time fires once. Hourly monitoring retains both real fall-back UTC hours.

Window identity uses canonical UTC intended time, independently of arrival time and transport event ID. Duplicate triggers reuse one logical window/work item. Bounded catch-up exposes a cursor and unprocessed intervals; missing intervals never become completed runs. Bounded source-membership pages use the existing queue within the same window. `continueWindow` requires the prior page to complete and preserves partial coverage. Renewed observation leases retain prior immutable receipts and cannot replace frozen material facts.

Migration admission requires source proof that the old trigger is disabled and the replacement/tool approval is current. The runtime does not modify real automations. Both trigger deliveries still derive the same window identity.

## Source and executor contracts

`RuntimeAuthority` resolves activation, window membership, per-item preflight and human-takeover receipts. It must synchronously fence the actual current source/cache state and observation lease. Structural validation is not qualification. A valid-looking client DTO or a function that echoes `allowed` cannot act as a source authority.

Preflight binds the exact registration hash, source window, item, checkpoint, account/action/route and policy/model/offer versions. It carries source-owned normalized record capacities for finite scope, shared quota, evidence review, applicable stock and budget. A known capacity is explicitly `remainingRecords` with its `sourceRef` and conversion/evidence `basisRef`; raw cents, stock units and API requests are not interchangeable. Unknown capacity holds. N/A requires a policy version and reason. Independent `ResourceGrant` objects retain their actual quantities, units and currency. The runtime never invents a conversion from dollars to records.

The source owns exclusive allocations shared across native/manual/API/browser routes. The runtime records consumption of an already-issued grant before transport invocation; it does not create an available balance. Operating quota is bounded to the existing safety margin under the published limit. Actual lease, source, machine, run control, applicable grants and finite work budgets are checked before each call and again before storing results.

`createJsonReadExecutor` performs a real bounded GET against a fixed server-configured endpoint: credentials are never read from an input; redirects are rejected; time and response bytes are bounded; output is parsed through a strict result schema. Source text cannot change the action, model, policy, destination or credentials.

`createBrowserReadExecutor` accepts a configured browser-worker page (the narrow interface is compatible with a Playwright Page). It visits the configured route, verifies origin/path and page version, then reads fixed structured selectors. It does not click login, MFA or CAPTCHA controls. API Unsupported may select a separately Ready browser route. Denied, missing or expired API permission never qualifies for fallback, and an action denial on another route cannot be bypassed. Login, MFA, CAPTCHA, UI drift and terms changes create an owned takeover. Resume requires an exact current source-issued resolution receipt; no caller Ready flag is accepted. Each real provider still needs separately qualified selectors, account permissions and source receipts.

## Modes, recovery and existing effects

- Observe records verified source observations locally.
- Propose records an immutable local review artifact; it confers no release or send.
- Execute-approved hands the exact finite manifest to the existing `DispatchGuard` and reports that actual run, without a wrapper run.
- Reconcile reads the original correlation/attempt and records actual facts. It cannot invent approval or a fresh business dispatch.

Approved handlers receive `assertCurrent()` for the final synchronous fence after their last await and immediately before the native effect. `approvalProof()` and `resourceGrants()` return defensive copies from the latest successfully fenced heartbeat; they are metadata, not standalone release authority or new allocations. The reconciliation context contains identity only and has no execution/heartbeat/grant/proof methods. Native operations still require source-enforced conditional/idempotent keys.

Safe reads retry within configured attempts, backoff and Retry-After. Checkpoints survive worker loss. Expired old workers cannot commit over the new worker. Uncertain external writes retain the existing exact-attempt dispatch fence and must reconcile before retry. Pause stops new calls; cancel affects unsent work while preserving actual native/accepted/earned/uncertain state. Source authorization errors remain protected-state denials; historical receipts do not become current permission.

## Measured usage and read projection

`RuntimeMeasurements` records actual instrumented direct API, MCP, model and browser invocations plus monotonic elapsed runtime. It does not infer Zap tasks from a network call. Ordinary Zap tasks, MCP tasks, tokens and prices require owning verified usage/billing receipts. Billing event identity prevents one event being counted in two task categories. Unknown values stay unknown, including total runtime dollars. A monetary subtotal is explicitly partial, and mixed currencies do not produce a comparable total. This is observation, not financial accounting or quota allocation.

Legacy base job usage returns unknown for registered source totals, while the runtime usage view exposes instrumented counts with explicit coverage. Source/preflight collectors can involve unmeasured external work; missing collector billing observations are not zero. Reused work creates no extra measured invocation.

Internal service reads include server-owned job definitions and references. They must not be sent directly to a browser. Public composition must authorize each read, apply scoped opaque aliases, remove secret/connection/source-private references, and preserve partial/stale/unknown states, due-window coverage and owned next actions.

`createRuntimeApi` is the narrow gateway for central HTTP composition. `authenticateMachine` checks the distinct configured server-only credential before body handling. Command schemas reject extra instructions and normalize scoped opaque references before the machine source issues an exact operation/input-hash proof, valid for no more than five minutes. The gateway applies the existing per-principal transport admission limits; these are not provider quota. Standalone reads default to gateway admission. Central HTTP composition explicitly selects compiled `readAdmission: "upstream"` only when its common authenticated route has already charged that same read once. Request input cannot select this mode; machine commands always use gateway admission. Credential/source-proof denial defaults to uncertain about prior work, while a known persisted receipt retains its actual certainty. Catch-up preserves an original uncertain attempt, and paused/held work with no recorded observation is not reported as an applied effect.

Browser reads require a freshly resolved named actor in the exact scope and a current source activation. Both retained source and actor proofs are synchronously checked after awaited work. The client-safe schemas in `runtimeViews.ts` expose scoped encrypted run/registration/item references, opaque evidence/owner aliases, counts and explicit source/usage coverage. No account, source locator, credential, executor definition or private subject is returned. `runtimeApi.ts` is server-only; the browser imports `runtimeViews.ts`.

The synthetic testkit uses actual SQLite, current-source fences and source-owned shared quota reservations, plus real HTTP and a finite browser-driver interface. It proves the software protocol, not a live provider connection. Testkit files are excluded from production packaging. Live adoption, source account qualification, trigger activation and production grants remain separate gates.
