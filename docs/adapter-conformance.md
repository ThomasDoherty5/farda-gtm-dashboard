# Adapter conformance

One suite, `src/adapter/conformance.ts`, holds every adapter to the same rules. The demo adapter and the live adapter stub run it today from `src/adapter/conformance.test.ts`. The authenticated adapter (THO-283) joins by adding one more target. Stage: fixture-complete. Nothing here is integration-verified.

The suite builds no transport and knows no backend URL.

## What it checks

| Rule ids | Rule |
| -- | -- |
| `IDENT-*` | The adapter reports its kind and environment. A live adapter is never `demo`. Responses carry the adapter's own environment. |
| `SCOPE-*` | Reads, actions and saves send the full requested scope. Responses echo it and match the contract strictly. A foreign environment is refused as forbidden. |
| `KEY-*` | Query keys include principal, environment, workspace and accounts. Changing any of them never shows the previous scope's data, with or without `keepPrevious`. |
| `AUTH-*` | 401 and 403 clear protected data. A 401 on an action does too. A 403 on an action fails that action only. |
| `PENDING-*` | An unavailable backend (`SOURCE_UNAVAILABLE`, `INTEGRATION_PENDING`) rejects, shows an error with no data, and never falls back to demo data. Unavailable writes report `notApplied`. |
| `VALUE-*` | Known zero, unknown and N/A stay distinct through the contract schemas and through adapter data. Missing data never becomes zero. |
| `IDEM-*` | A write needs an idempotency key. Repeating it returns the first answer. The same key with a changed payload is refused. |
| `VER-*` | A stale expected version is a recoverable `STALE_VERSION` conflict. It applies nothing and returns `currentVersion`. |
| `SENT-*` | Approved is not Sent. An approval has no receipt and no success state. Dispatch before approval is refused. A success needs a source receipt. An unknown outcome is not success. |
| `SCHEMA-*` | Bad shapes and unknown fields are rejected. See the note on strictness below. |

## Plugging in THO-283

1. Add a target in a test file. Copy the demo target in `conformance.test.ts`.
2. Fill `create` (a fresh adapter per call), `scope`, `read` and `canServeData: true`.
3. Add scenarios as the sandbox allows:
   - `unauthenticated`, `forbidden` and `unavailable`: adapters whose reads fail in that way. These may wrap the real adapter over a test double for the network. They must not stub the adapter's own error mapping.
   - `actions`: an approval that can be decided and dispatched, plus `uncertainApprovalRef` for an unknown outcome.
   - `saves`: a versioned resource and a payload that changes it.
   - `valueStates`: reads that return a known zero, an unknown and a not-applicable value.
4. Delete the target's `gaps` entries as each scenario lands. Run `npm test`.

A rule with no scenario is never skipped quietly. It must have a reason in `gaps`, which registers an `it.todo`. A rule with no scenario and no reason fails. `knownFailures` registers an `it.fails` with its reason, and it goes red when the rule starts passing so the entry gets removed. A reason that names no registered rule fails too.

## Live stub today

The stub rejects every call with `INTEGRATION_PENDING`. It passes the `PENDING-*` rules and `IDENT-1`, and the hook-level scope checks that only need a recorded request. The rules that need an answer from a backend are `it.todo` with the reason, 34 of them at the time of writing.

## Notes for the THO-283 freeze

- The contract's zod schemas are plain `z.object`, so they strip unknown fields instead of rejecting them. The suite parses responses with `deepStrict`, a strict copy of the same schemas, so a backend that adds fields fails. `SCHEMA-3` is an expected failure that records this. Decide whether the contract itself becomes strict, then remove it.
- The contract has no zod schema for the save response. The suite carries a local mirror of `SaveResourceResponse`. Move it into `contract.ts` when the freeze lands.
- The demo adapter now refuses an empty idempotency key with `VALIDATION_FAILED`, which `IDEM-1` and `IDEM-4` required.
- `PENDING-4` is pending for the demo: its offline fixture fails reads only.
