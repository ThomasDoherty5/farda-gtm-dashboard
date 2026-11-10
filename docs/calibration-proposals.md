# Evidence-policy calibration proposals

`src/creator-agent/calibration/` holds human-reviewed proposals that change the creator **evidence policy**: the anchors and gates reviewers apply before any score is used. Only this mode exists. Numeric calibration of weights, bands, decision rules or outcome links needs mature retained-sales cohorts, and none exist yet. Any request for it, including `createProposal({ mode: "numericCalibration" })` and `requestNumericCalibration()`, returns a structured `blocked` report with `MATURE_RETAINED_SALES_COHORTS_UNAVAILABLE`.

The release stage is **fixture-complete**. It is tested with synthetic packets, a synthetic evidence basis and fictional J04 humans. No server read is wired.

## What a proposal can change

The named, immutable baseline is `evidence-policy.2026-11-04.launch-v1`. It mirrors the live launch gates in `policy.ts`. A conformance test proves the gate states and reasons are identical. The floors and anchors are read from `ratingPolicy.ts`.

| Field | Baseline |
| -- | -- |
| `likeGate.minNativeLikesExclusive` | Exact native likes must be greater than 200 |
| `packet.minIndependentPosts`, `minPublicationDates`, `minMeaningfulUsePosts` | 3 posts, 2 dates, 2 use examples |
| `criticalFloors.routineFit`, `criticalFloors.demonstrationStorytelling` | 3/5 each |
| `anchors.<criterion>.<0-5>` | The six rubric anchors for each of the six criteria |

Each version also carries the approved v3 numeric identities as hashes: model id, config hash and numeric hash. They are copied unchanged from version to version. Promotion refuses a version whose numeric hashes differ from the baseline's. Any change that names a numeric surface is refused as a whole with `NUMERIC_MODEL_CHANGE_REFUSED`, even when it is mixed with valid evidence-policy changes. Numeric surfaces include `criteria`, `weights`, `bands`, `arithmetic`, `decisionRules`, `modelId` and `numericBindings`.

Promotion records an approved immutable version. It does **not** change live assessment. `assessCreator` still uses the hard-coded launch gates in `policy.ts`. Applying a promoted version to live assessment is a separate change that needs an owner decision.

## Lifecycle

1. **Propose** (`createProposal`). The proposal names the base version and lists each changed field with its `before` value, `after` value and rationale. `before` must equal the base. The proposal also records:
   - its evidence basis and that basis's limits;
   - a comparison over a synthetic candidate set;
   - the resulting config and its hash.

   The base must be the current head. Proposals, versions and outcomes are append-only; SQLite triggers reject any update or delete.
2. **Approve** through the existing J04 approval repository. `createCalibrationApprovalRegistry` presents the proposal as a J04 `policyChange` manifest. The manifest has no spend, creator send or stock effect, and its payload hash is the proposal hash. J04 then requires:
   - a verified Slack decision with a Linear readback;
   - founder authority;
   - a decider who is a different person from the proposer. The registry requires the J04 previewer to be the proposal's author.
3. **Promote** (`promote`). This applies an approval and is the only way the head moves. It resolves a current J04 proof for this exact proposal. After that await, it reads the clock and re-asserts the proof inside its own `BEGIN IMMEDIATE` transaction. It then writes `evidence-policy.rev-N` with the approver's principal, person and receipt. An observed approval alone changes nothing.
4. **Reject or withdraw** (`recordDecision`). This records a verified J04 `rejected` or `canceled` receipt against the proposal, with the named decider.
5. **Expire** (`expireDue`, or inside `promote`). This records an expiry once `expiresAt` passes. A proposal whose base is no longer the head reads as `stale` and cannot be promoted.
6. **Roll back** (`proposeRollback`). A rollback is an ordinary proposal: its after-values are an earlier version's config, and it goes through the same approval. The new version's config equals the target's. All earlier versions remain readable.

Commands take idempotency keys. Reusing a key with a different body returns `IDEMPOTENCY_KEY_REUSED`. The repository checks the shared `agent_scope` and uses only `calibration_*` tables.

## How the J21 criteria are interpreted here

- **Evidence basis and limits (J21-06).** Every confident proposal records:
  - the basis reference and version;
  - the window and source kinds;
  - counts of reviewed packets, distinct creators and reviewer disagreements;
  - at least one stated limit;
  - `retainedSalesCohorts: unavailable`.
- **Insufficient evidence (J21-07).** An unknown count or invalid window returns `blocked`. Unknown counts are never treated as zero; a known zero is a separate block. Known counts below the minimums return a `provisional` report with `promotable: false`, which is never stored as a proposal. The current minimums are 20 reviewed packets and 10 distinct creators.
- **No demographic, diagnosis or sales inference (J21-10).** The basis schema has no field for audience, health or sales inputs. Candidate sets must be labeled synthetic, with `synthetic-` creator ids. The comparison reports only packet-gate states. Author-supplied rationales and changed anchor text are screened for diagnosis, protected-demographic and sales-outcome wording. Unchanged baseline anchors are not screened; the audience anchors legitimately name authorized aggregate age dimensions. The screen is a floor, not a classifier, and the named approver still reviews the text.
- **Approved v3 model unchanged (J21-11).** In this mode, proposals may target evidence-policy anchors and gates only, never numeric weights. Model identities, weights, arithmetic and bands stay as approved.

## Comparison

`compareConfigs` runs the prior and proposed configs over a labeled synthetic candidate set. The set is capped by its declared `limit` and by a hard maximum of 25. For each candidate, the result shows:

- the prior and proposed recommendation (`pass`, `hold` or `reviewNeeded`);
- each gate whose state or reason changed;
- the changed config fields that drove each gate change.

Numeric scoring is reported as `unchanged-not-evaluated`. Anchor edits are listed as `humanReReviewRequired`, because saved ratings are never re-rated automatically. The report says it is not a population estimate.

## Owner decisions needed

- Minimum evidence for a confident proposal. The provisional values are 20 reviewed packets and 10 distinct creators.
- Whether, and how, a promoted version should drive live `assessCreator` gates. That would change `policy.ts` and `POLICY_VERSION`.
- The J04 policy version and Linear issue reference for calibration approvals in deployment. No default is shipped.
- Whether to expose a read-only route. None is wired yet.
