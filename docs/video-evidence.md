# Video evidence ledger (J20)

J20 collects direct lifestyle-video evidence and versions it. J02 (`src/creator-agent/policy.ts`) still owns assessment, ratings, the 3/5 floors and the arithmetic. J20 assigns no score, sends nothing and authorizes no spend.

The module lives in `src/creator-agent/videoEvidence/`. It is not wired to a server route, and its runtime executor is not registered.

| File | Purpose |
| -- | -- |
| `schema.ts` | `VideoEvidenceRecord`, `MetricObservation`, `AudienceEvidence`, the reader contract, and the J20 input and output. Version `farda.video-evidence.v1`, collector `j20-collector.v1`. |
| `rules.ts` | Pure rules: the native-like gate, viewing status, lifestyle taxonomy, audience proof, next action, and the mapping to the J02 packet. |
| `ledger.ts` | An append-only ledger in the shared agent SQLite file, in `video_evidence_*` tables. |
| `collector.ts` | The collector, built around an injected `VideoSourceReader`, plus the human claim-decision path. |
| `executor.ts` | A `RuntimeExecutor` shaped for a daily `J20` registration. |

## Policy the code enforces

- **Deep-review gate.** A post gets playback review only when it has strictly more than 200 native visible likes, and the raw label must match the exact value. A post with exactly 200 likes fails. Hidden, absent, rounded (`1.2K`), ambiguous (`200+`) and third-party counts stay pending, with `needs_metric_proof`. The gate reuses `policy.likeGate`.
- **Lower-like posts.** These are stored as metadata for the reach baseline (`deriveMetadataBaseline`). They carry `deep_review.credit: false`, are never opened for playback, and never enter the J02 packet.
- **Packet coverage.** The rule is three distinct relevant posts on two or more dates, with two or more brief-matched shown actions. These counts come from running `assessCreator` with no bound configuration, so no score exists. A short packet stays `needsEvidence`, never zero.
- **Viewing.** Status is derived from observed intervals only. Elapsed player time is kept, but it never counts as coverage. Sampled frames are points, so `sampled_playback` is never treated as continuous. Statuses are `complete_audio_visual`, `full_visual_only` (muted or unheard), `partial_playback` (interrupted), `metadata_only` (caption only) and `not_opened`. Access states are recorded separately.
- **Audio.** A machine transcript (`asr`) is never heard audio, and unassessed audio stays `unknown`.
- **Observations.** Shown action, narration and caption text are separate channels. Reviewer interpretation is a separate field. Only a shown action inside the observed range counts as a J02 action. Outcome causality stays `unresolved`. Neither a retail CTA nor Shop linkage is required.
- **Metrics.** A `null` value requires a `missing_reason`, and a value cannot carry one. The raw label, unit, window and snapshot time are kept.
- **Taxonomy.** The lifestyle buckets are GRWM, workday, organization, travel/purse and practical product use. Clinical lectures, IVF/fertility explainers and generic medical education are excluded. Educator status changes nothing. The output gives counts, never percentages or weights.
- **Audience.** Only a verified, dated native report or creator export with provenance is accepted as audience proof. The schemas have no field for face, voice, name, location or health inference.
- **Claims.** A collector cannot resolve a claim. Compatibility, medical and outcome claims return `needs_claim_review`. `decideClaim` accepts only a reviewer or owner and appends a new version. The J02 packet also carries each claim as a target for the existing `EvidenceReviewRepository` annotations.
- **Comments.** The sample reuses the J02 comment schema: up to 20 rows, with the declared n equal to the inspected rows. An unobserved sample has `null` counts, not zero.

## Ledger behaviour

- **Writes.** Every write runs under `BEGIN IMMEDIATE`, and the clock is read inside the lock. Triggers abort any `UPDATE` or `DELETE` on records and access events.
- **Idempotency.** A retried request key returns its original receipt. A reused key with different input is refused. A new run with identical content reuses the latest version instead of adding a duplicate.
- **Identity.** The record key comes from the platform, the resolved creator source ID and the native post ID. When the native post ID is missing, a controlled URL fingerprint is used. No ID is invented.
- **Access failures.** Login, MFA, permission denied and unavailable are written to `video_evidence_access_events`, and prior evidence is untouched. A removed or changed post becomes a new version, and earlier versions stay readable.
- **Resuming.** The cursor names the next post. For a post that passed the gate, it also names a staged metadata row, so the review step resumes without re-reading committed posts.

## Runtime

The runtime grants one source-quota unit per work step, so the executor makes one source call per step: a metadata read or a playback review. The step outcomes are:

- `checkpoint` advances the cursor.
- Login and MFA return `takeover`.
- A denied permission returns `held`.
- A transient outage returns `retry`.
- Invalid source data returns `held` with its reason code.

Registering it means a `J20` family registration, a daily calendar cadence, observe mode and `executorRef: "j20-video-evidence.v1"`, plus a server-side `loadInput`.

## Stage

Fixture-complete only. All fixtures are synthetic (`fixtures.testkit.ts`). No collector has read a real source, so the J20-10 run trace and evidence-quality report over real collector records remain open.
