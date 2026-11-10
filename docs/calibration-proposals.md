# Evidence-policy calibration proposals

`src/creator-agent/calibration/` holds human-reviewed proposals that change the creator **evidence policy**: the anchors and gates reviewers apply before any score is used. Only this mode exists.

Numeric calibration of weights, bands, decision rules or outcome links needs mature retained-sales cohorts, and none exist yet. Any request for it returns a structured `blocked` report with `MATURE_RETAINED_SALES_COHORTS_UNAVAILABLE`. That includes `createProposal({ mode: "numericCalibration" })` and `requestNumericCalibration()`.

The release stage is **fixture-complete**. It is tested with synthetic packets, a synthetic evidence-basis resolver and fictional J04 humans. No server read is wired.

## What a proposal can change

The named, immutable baseline is `evidence-policy.2026-11-04.launch-v1`.

`policy.ts` hard-codes its gate values and does not export them, so the baseline restates them. Two tests keep the copies honest:

- The content gates match `policy.ts`, state for state and reason for reason, on a 10-packet synthetic boundary set.
- A drift test fails if any baseline literal moves away from the boundary where `policy.ts` actually flips that gate.

The floors and anchors are imported from `ratingPolicy.ts`.

| Field | Baseline |
| -- | -- |
| `likeGate.minNativeLikesExclusive` | Exact native likes must be greater than 200 |
| `packet.minIndependentPosts`, `minPublicationDates`, `minMeaningfulUsePosts` | 3 posts, 2 dates, 2 use examples |
| `criticalFloors.routineFit`, `criticalFloors.demonstrationStorytelling` | 3/5 each |
| `anchors.<criterion>.<0-5>` | The six rubric anchors for each of the six criteria |

Gates may be loosened, but never silently. The stored comparison lists every gate set below the launch baseline in `weakensBaseline`, which is the first field of the comparison. A value of zero is marked `disablesGate`. The summary counts these entries, so an approver sees them before any candidate rows.

Each version also carries the approved v3 numeric identities as hashes: model id, config hash and numeric hash. They are copied unchanged from version to version. Promotion refuses a version whose numeric hashes differ from the baseline's.

Any change that names a numeric surface is refused as a whole with `NUMERIC_MODEL_CHANGE_REFUSED`, even when it is mixed with valid evidence-policy changes. Numeric surfaces include `criteria`, `weights`, `bands`, `arithmetic`, `decisionRules`, `modelId` and `numericBindings`.

Promotion records an approved immutable version. It does **not** change live assessment. `assessCreator` still uses the gates hard-coded in `policy.ts`.

## Evidence-basis verification

A proposal's author states an evidence basis: a reference, a version, a window, source kinds, counts and limits. The counts are only a claim. The server checks them through a configured `basisResolver`, which reads the authoritative review records for the scope and window.

- **No resolver configured.** Every evidence-policy proposal is held as `EVIDENCE_BASIS_UNVERIFIED`. It is not stored and never reaches J04.
- **Window still open.** The window's end must be at or before the proposal's creation time, by the injected clock. Otherwise the proposal is held as `EVIDENCE_WINDOW_NOT_CLOSED` before the resolver is called. An open or future window could gain records later, change the resolved counts and block approval for good.
- **Observation not accepted.** The resolver must echo back the scope, basis, window and `sourceKinds`, and each must match exactly. The `sourceKinds` must be the same kinds in the same order. The observation must also be no older than 10 minutes and not dated in the future. Otherwise the proposal is held as unverified.
- **Claim differs from the resolved counts.** The proposal is held as `EVIDENCE_BASIS_MISMATCH`.
- **Sufficiency and the J04 gate.** Both use the resolved counts only.
- **Reviewer disagreements.** This count is not resolved. It stays an unverified claim.

The resolver is an injected interface with no default. The existing review stores keep per-assessment packets and per-post annotations. They do not define what counts as a reviewed packet across a window, and that definition is an owner decision. A deployed resolver must be built over the authoritative records once it is made.

## Lifecycle

1. **Propose** (`createProposal`, async). The proposal names the base version. It lists each changed field with its `before` value, `after` value and rationale; `before` must equal the base. It also records:
   - the evidence basis as claimed;
   - the resolved counts and their observation time;
   - a comparison over a synthetic candidate set;
   - the resulting config and its hash.

   The base must be the current head. Proposals, versions, outcomes and basis observations are append-only; SQLite triggers reject any update or delete.
2. **Approve** through the existing J04 approval repository. `createCalibrationApprovalRegistry` presents the proposal as a J04 `policyChange` manifest. The manifest has no spend, creator send or stock effect, and its payload hash is the proposal hash.
   - J04's `sourcePermission` gate is satisfied only by a fresh resolver observation. The registry re-resolves the basis on every preview and on every current-proof check.
   - The gate's version is bound to the resolved counts, so changed counts hold the approval. Its validity ends 10 minutes after the observation, not at the proposal's expiry.
   - The gate does not represent a provider or creator permission.
   - For a rollback, the gate's source is the target version in this module's own immutable table.
   - More than 10 minutes after the last observation, J04's `readApproval(...).current` can show the source gate as stale until a proof is resolved again. This is expected. The basis is re-verified whenever a decision is observed or a proof is resolved.

   J04 then requires a verified Slack decision with a Linear readback, founder authority, and a decider who is a different person from the proposer. The registry requires the J04 previewer to be the proposal's author.
3. **Promote** (`promote`). This applies an approval and is the only way the head moves.
   - It resolves a current J04 proof for this exact proposal.
   - After that await, it reads the clock and re-asserts the proof inside its own `BEGIN IMMEDIATE` transaction.
   - It then writes `evidence-policy.rev-N` with the approver's principal, person and receipt.
   - After the commit, it links the new version to the approval through J04's public `recordOutcomeLink`. The result reports `j04Outcome` as either `recorded` or `notRecorded` with a reason.

   An observed approval alone changes nothing. If `promote` returns `j04Outcome: notRecorded`, the version is promoted, but the caller must replay `promote` with the same idempotency key to link the outcome. No background sweep retries it.
4. **Reject or withdraw** (`recordDecision`). This records a verified J04 `rejected` or `canceled` receipt against the proposal, with the named decider. Only the approval's head manifest version counts. A decision on an older version is refused as `STALE_DECISION`, so an earlier rejection cannot override a later approval.
5. **Expire** (`expireDue`, or inside `promote`). This records an expiry once `expiresAt` passes. A proposal whose base is no longer the head reads as `stale` and cannot be promoted.
6. **Roll back** (`proposeRollback`). A rollback is an ordinary proposal: its after-values are an earlier version's config, and it goes through the same approval. The new version's config equals the target's. All earlier versions remain readable.

Commands take idempotency keys. Reusing a key with a different body returns `IDEMPOTENCY_KEY_REUSED`. A report that depends on the resolver is not cached, so a retry can succeed once the source verifies.

## SQLite connection requirement

The calibration repository and the J04 approval repository must use the **same `DatabaseSync` connection**. Promotion calls J04's synchronous `assertCurrentProof` inside the calibration `BEGIN IMMEDIATE` transaction. That fence is atomic with the version write only when both repositories share the connection. The authority passed to `CalibrationRepository` must include that connection as `database`, and the constructor refuses any other connection with `APPROVAL_CONNECTION_MISMATCH`.

To record J04 outcome links, the J04 repository must be constructed with `verifyOutcome: input => calibration.verifyOutcome(input)`. That check accepts only an outcome that matches a promoted version exactly. The repository also checks the shared `agent_scope` and uses only `calibration_*` tables.

## How the review criteria are interpreted here

- **Evidence basis and limits.** Every confident proposal records:
  - the claimed basis, its window, source kinds and stated limits;
  - `retainedSalesCohorts: unavailable`;
  - the resolver's counts and observation time.
- **Insufficient evidence.** An unknown resolved count or an invalid window returns `blocked`. Unknown counts are never treated as zero; a known zero is a separate block. Resolved counts below the minimums return a `provisional` report with `promotable: false`, which is never stored. The current minimums are 20 reviewed packets and 10 distinct creators.
- **No demographic, diagnosis or sales inference.** The basis schema has no field for audience, health or sales inputs. Candidate sets must be labeled synthetic, with `synthetic-` creator ids, and the comparison reports only packet-gate states. A screen covers every free-text and reference field a person supplies:
  - rationales and changed anchor text;
  - basis references, limits and reasons;
  - rollback reasons and limits;
  - candidate-set and candidate labels and references.

  The screen refuses diagnosis, protected-demographic and sales-outcome wording. Unchanged baseline anchors are not screened, because the audience anchors legitimately name authorized aggregate age dimensions. The screen is a floor, not a classifier, and the named approver still reviews the text. To describe what a basis excludes, use general words such as "no audience data" rather than naming a category.
- **Approved v3 model unchanged.** Proposals may target only evidence-policy anchors and gates, never numeric weights. Model identities, weights, arithmetic and bands stay as approved.

## Comparison

`compareConfigs` runs the prior and proposed configs over a labeled synthetic candidate set. The set is capped by its declared `limit` and by a hard maximum of 25. The report lists:

- the gates set below the launch baseline;
- for each candidate, the prior and proposed recommendation (`pass`, `hold` or `reviewNeeded`);
- each gate whose state or reason changed, with the changed config fields that drove it.

Numeric scoring is reported as `unchanged-not-evaluated`. Anchor edits are listed as `humanReReviewRequired`, because saved ratings are never re-rated automatically. The report says it is not a population estimate.

## Owner decisions needed

- What counts as a reviewed packet and a distinct creator for the deployed `basisResolver`, and which records it reads.
- Minimum evidence for a confident proposal. The provisional values are 20 reviewed packets and 10 distinct creators.
- Whether loosening a gate below the launch baseline should need more than the flag, such as a hard minimum.
- Whether, and how, a promoted version should drive live `assessCreator` gates. That would change `policy.ts` and `POLICY_VERSION`.
- The J04 policy version and Linear issue reference for calibration approvals in deployment. No default is shipped.
- Whether to expose a read-only route. None is wired yet.
