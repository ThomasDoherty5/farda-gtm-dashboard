# Direct video evidence (J20)

J20 observes Instagram and TikTok lifestyle videos and versions what it saw. It does not keep its own ledger. A collected page becomes a new revision of the existing creator evidence packet (`src/creator-agent/evidence.ts`), written through the same writer as the reviewer `PUT /v1/creators/:id` route. J02 (`policy.ts`) still owns assessment, ratings, floors and arithmetic. J20 assigns no score, resolves no claim, sends nothing and authorizes no spend.

## Wiring

| Piece | Role |
| -- | -- |
| `creatorEvidenceWriter.ts` | The one writer. It aliases comment authors and provider accounts, resolves server-held route proof, runs `assessCreator` and appends through `AgentStore.save`. The reviewer route and the J20 executor both call it. |
| `videoEvidence/runtime.ts` | `bindVideoEvidence` registers the executor on an existing compiled daily `J20` observe registration, through `options.runtime.registry`. `server.ts` only composes it. |
| `intake/repository.ts` | `reviewWork(creatorId)` is the executor's input. It returns work only while the creator's latest revision came from a discovery event that emitted `nextWork: "J20"` and its enrollment is still verified. |
| `videoEvidence/contract.ts` | The collector request and response. A collector returns one bounded page, a login or MFA takeover, a denial, or a retryable outage. |
| `videoEvidence/packet.ts` | Merges one page into the latest stored packet. It applies the like gate, the taxonomy, the inference screen and the change rules. |
| `videoEvidence/quality.ts` | The evidence-quality projection, returned as `videoEvidenceQuality` on the `evidenceRecord` read for collected packets only. It is not rendered yet. |
| `videoEvidence/fixtures.testkit.ts` | The synthetic sandbox collector and fixtures. It is a test double only. |

The runtime owns cadence, leases, quota, checkpoints, retries and takeovers. Each step makes one collector call and at most one evidence write. A step with more pages returns a checkpoint. A login or MFA response becomes the runtime's owned takeover, and work resumes from the last checkpoint only after a source-issued resolution receipt. A source-level denial holds the item and writes nothing. The run trace is the existing `runDetail` read.

## Versions

| Version | Value |
| -- | -- |
| Packet marker | `collection.schemaVersion` = `farda.video-evidence.v1` |
| Sampling policy | `approved-creator-scorecard-policy.2026-11-04`, the owner-approved scorecard policy revision (the same revision as `POLICY_VERSION`) |
| Taxonomy | `j20-lifestyle-taxonomy.v1` (vocabulary label; see NEEDS-OWNER) |
| Collector request | `j20-collector-request.v1` |
| Executor | `j20-video-evidence.v1` |
| Collector | `collection.collectorVersion` and `collection.collectorStage`, as declared by the bound collector |

Every new field is optional, so earlier packets, assessments, packet hashes and idempotency receipts parse and compare unchanged. A packet that carries `collection` must state source provenance, context, counters, access and playback facts on every reviewed post. The agent version is now `1.2.0`, following the earlier output-shape bump: assessments gained `routeEvidence.unavailableMetrics`, the `CLAIMS_REVIEWED` gate and access-aware packet counts. Stored `1.0.0` and `1.1.0` assessments still parse and read as stale, as before.

## Where each rule comes from

| Source | Rules |
| -- | -- |
| Approved scorecard policy, 2026-11-04 | Strict >200 native likes; 3 posts on 2 dates with 2 action posts; 10 recent relevant unpinned posts including lower-like ones; up to 20 visible comments; observed action, narrated claim and unknown recorded separately; sampled points never become a continuous interval; audience only from actual aggregate evidence. |
| Main before this work | Completion needs watched intervals or sampled points plus a receipt; a sampled-frame review can be complete; heard claims need heard audio. These are kept unchanged. |
| J20 / J02 acceptance criteria | Clinical lecture, IVF/fertility explainer and generic medical education exclusions; caption-only evidence cannot satisfy watched footage; hidden counts stay null; elapsed playback is never coverage. |
| New in this work, not gating | Viewing-status labels, the 0.5 s full-coverage edge allowance, bucket labels and the quality projection. They describe; they gate nothing. |

## Rules the code enforces

- **Identity.** The record ID derives from the creator and the native post identity, never from a caller label. Identical facts on a later read reuse the stored revision. Observation and receipt times alone never create a new one.
- **Like gate.** Only posts with strictly more than 200 exact native likes are deep-reviewed. Exactly 200 fails. Hidden, rounded, ambiguous and third-party counts stay pending with their raw label. Lower-like posts join the recent metadata baseline only. A review offered for one is dropped and the exclusion is recorded.
- **Coverage.** Derived status comes from observed ranges and frames. Elapsed playback, muted playback and caption text never earn coverage, and elapsed time alone cannot complete a review. J02 completion keeps main's rule; a complete review without full-clip coverage is reported as `COMPLETE_REVIEW_WITHOUT_FULL_COVERAGE`, not refused. The six fixtures (complete, sampled, caption-only, muted, interrupted, blocked) derive six distinct statuses. Sampled frames remain credited exactly as on main, labelled sampled and never continuous.
- **Observations.** Every collected shown action carries its kind, and only shown handling, operation or use can count as brief-matched use. Narration and reviewer inferences are stored separately. Neither a CTA nor a Shop anchor is required. Outcome causality is always reported as unresolved. A collected review is always attributed to the agent (`agent:j20-video-evidence.v1/<collector>`), whatever reviewer the collector names.
- **Counters.** A hidden or missing counter is null with its reason, never zero. Raw label, unit, definition, window and snapshot time are kept. Provider route metrics gain the same provenance, plus a separate unavailable list.
- **Taxonomy.** Clinical lectures, IVF/fertility explainers and generic medical education are excluded. The GRWM, workday, organization, travel/purse, practical-use, other and unknown labels are recorded and gate nothing; relevance otherwise follows the brief. Educator status is recorded and changes nothing.
- **Audience.** New provider proof with an aligned or misaligned audience must name an authorized native report or dated creator export and its provenance. A collector cannot verify audience evidence: anything it supplies is stored unverified. No schema has a field or route for face, voice, name, appearance, health or location inference.
- **Claims.** Every collected claim states a topic. Compatibility, medical, outcome and uncategorized topics need a person, and so does explicit medical, diagnostic or treatment-outcome wording under any topic. Everyday phrases such as "treat yourself" or "retail therapy" do not. Each such claim is kept in `collection.claims` by post and claim, even after a later read stops showing it or a missing fingerprint resets the review.
  - Each listed claim, current or carried, has its own `claim-digest-<hex>` reviewer target on the current run, bound to the exact post and claim. A reworded claim is a new target.
  - J02 records `CLAIMS_REVIEWED: unknown` while any listed claim lacks a person's disposition.
  - A person disposes of a claim through the existing reviewer disagree/override path. Right after the save, the server appends a re-assessed revision through the shared writer (trigger `reviewerDisposition`), so the stored assessment reflects the ruling without a J20 run. Every later write also merges saved rulings before J02 runs. A collector or a reviewer packet write cannot add a disposition.
  - For `claim-digest-` targets only, the ruling is the resolution: it raises no open dispute and survives re-collection of the same claim. Every pre-existing target, including `claim-N`, keeps main's dispute rule unchanged. Diagnosing, demographic, purchasing-power and outcome-promising text that Farda authors is withheld by the inference screen and recorded by field.
- **Access.** Removed, changed, login-required and denied posts keep their earlier observation and record the new access state beside it. J02 counts only posts whose original is still reachable. Changed footage, or footage whose fingerprint is missing, is not re-credited until it is reviewed again. History is never edited.
- **Ratings.** Reviewer creative ratings carry to a new collected revision only while every rated post is present with the same confirmed footage and the same footage facts: methods, ranges, points, actions, claims and narration. A new receipt or review time, a like-count change or a newly found post keeps them. A new brief, brief version or route carries nothing.
- **Reviewer writes.** The rule follows the base revision the reviewer edited from. If it was collected, the brief, route, `collection`, every reviewed post and every recent-post row must come back exactly as stored; only ratings, criterion ratings, gates and revision labels may change (`J20_COLLECTION_READ_ONLY`). An uncollected packet cannot gain J20 provenance this way. A missing base revision is `VERSION_CONFLICT`.
- **Leaving collection.** The only exit is an audited `detachedCollection`. It names the latest collected revision of the brief, its evidence revision and a reason, and the server stamps the reviewer principal.
  - Every uncollected reviewer write is judged against the latest collected revision of its target brief. Without that detach, no write can put uncollected facts on a collected brief, so a hop through another brief cannot launder them back.
  - No reviewer write may carry J20 provenance, J20 record identities (`j20-…`, `media-…`), or a native post J20 collected for this creator.
  - History keeps the collected revision unchanged. J02 reports `J20_DETACHED` while the packet is detached.
  - J20 holds with `J20_COLLECTION_DETACHED` while the latest packet is detached on the queued brief. A reviewer write that drops the marker, or a new brief, lets collection resume.
- **Reviewer-entered packets.** Reviewer evidence is replaced only when J20 has at least one accessible, sourced post (otherwise `J20_AWAITING_ACCESSIBLE_EVIDENCE`). Its packet must also be at least as complete: as many qualifying posts, or its own packet gates passing (otherwise `J20_LESS_COMPLETE_THAN_REVIEWER_EVIDENCE`). When J20 does replace the evidence, the collected post set starts from J20 posts, the reviewer's gates, terms and criterion ratings are kept, and creative ratings return to unknown because the rated footage is no longer in the packet.
- **Privacy.** Provider accounts and comment authors are stored only as scoped aliases. Run views alias creator subjects.

## Contract notes

- **Collector request.** It carries the approved review requirements, the deployment's source permission refs, the research gate ref and the stored evidence it extends.
- **Collector stage.** A collector reports `source` only with a deployment-held qualification record, which is stored as `collection.collectorQualification` on every packet it writes. Otherwise only `synthetic-fixture` is accepted. Capabilities show `collectorQualification`. Main has no source-held collector-qualification registry to verify the record against, so verifying it stays with the owner. The runtime still requires the registration's capability binding to be Ready in the capability ledger before any run.
- **Post counters.** Each counter is a single-post raw count, so numerator, denominator and cohort do not apply; the cohort is the post itself. Route metric provenance stays optional so stored assessments parse; requiring it on new provider snapshots belongs to the scorecard source owner.
- **Next action.** J20's `nextAction` is a projection for people. J02 does not consume it; J02 reads the stored evidence and its own gates, including `CLAIMS_REVIEWED`.
- **`videoEvidenceQuality`.** This is a new browser-visible field on `evidenceRecord`. It is not rendered and needs the contract owner's sign-off.

## NEEDS-OWNER

- Whether a removed post's earlier observation may still count. Until decided, J02 does not credit removed, denied, login-gated or unavailable posts.
- Whether a "complete" review must cover the whole clip, with what edge tolerance, and whether an interruption blocks completion. Until decided, main's completion rule stands and coverage is only reported.
- Confirmation of the lifestyle vocabulary and its version label. Only the three exclusions gate today.
- An explicit human "accepted" disposition for collected claims. The reviewer path offers disagree and override only. On a J20 `claim-digest-` target either one resolves the claim; on main's `claim-N` targets it still opens a dispute under main's rule.
- The scoped change to dispute semantics: a ruling on a J20 `claim-digest-` target is treated as resolved by `contested`. Main's targets are untouched. This needs the evidence-review owner's sign-off.
- Whether reviewers may reuse J20 values (identities or the same native posts) after a detach. Refused by default.
- The completeness rule for J20 replacing reviewer-entered evidence (today: as many qualifying posts, or J20's packet gates passing).
- Access-aware packet counts also apply to reviewer-entered packets that record access. A reviewer packet with one deleted post counted three qualifying posts on main and counts two now (`e2e-agent/evidence-review.spec.ts` writes exactly this and still passes).
- Whether reviewer creative ratings should carry when J20 first replaces reviewer-entered posts. Today they return to unknown, because the rated footage is no longer in the packet.

## Stage

**Fixture-complete only.** All collector evidence in this repository is synthetic. The sandbox collector reports `synthetic-fixture` in `/v1/capabilities` and on every packet it writes. It refuses to start when `NODE_ENV` is `production`, the same guard as the reference test double. Testkit files are excluded from the API image.

These remain open and are not claimed:

- **J20-10 actual collector and source records.** No qualified collector has read a real Instagram or TikTok source. A real collector, its account permissions, selectors or API scopes, and its source receipts need their own qualification. The quality projection labels synthetic packets `SYNTHETIC_FIXTURE_COLLECTOR`.
- **J20-08 authorized audience reports.** No real authorized native report or creator export has been ingested. Every collected packet reports `NO_VERIFIED_AUDIENCE_REPORT` until one is.
- **Rendering.** `videoEvidenceQuality`, narration, counters and context reach the browser schema but are not rendered. That waits for the original design.
