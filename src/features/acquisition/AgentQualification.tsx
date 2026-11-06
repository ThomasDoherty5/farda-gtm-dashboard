import { Badge } from "@/components/Badge";
import { DataTable } from "@/components/DataTable";
import { Kpi } from "@/components/Kpi";
import type { CreatorAssessment } from "@/creator-agent/assessmentSchema";
import type { EvidencePacket } from "@/creator-agent/evidence";
import { formatTime } from "./evidenceRules";
import styles from "./Acquisition.module.css";

export const rating = (value: number | null) => value === null ? "Unknown" : `${value} / 5`;
const known = (value: number | null) => value === null ? "Unknown" : value.toLocaleString("en-US");
export const decisionLabel = { reviewNeeded: "Review needed", hold: "Hold", prospectiveInviteEligible: "Prospective invite eligible", activationReady: "Activation ready" } as const;

/** Renders the server result; this screen has no scoring, configuration publication or eligibility override. */
export function QualificationDetails({ assessment: a, packet, savedConfiguration = false }: { assessment: CreatorAssessment; packet?: EvidencePacket | null; savedConfiguration?: boolean }) {
  return <div className={styles.stack} data-testid="agent-qualification">
    <p><Badge tone={a.state === "hold" ? "warning" : "violet"}>{decisionLabel[a.state]}</Badge> · Assigned brief: {a.briefId} · Content qualification: {a.contentQualification}</p>
    <DataTable caption="Agent assessment versions" columns={[{ label: "Reference" }, { label: "Server value" }]} rows={[
      ["Policy", a.policyVersion], ["Agent / schema", `${a.agentVersion} / ${a.schemaVersion}`], [a.routeEvidence && !a.routeEvidence.verifiedModelId ? "Candidate model · route unverified" : "Model", a.modelId],
      ["Configuration", `${a.config.status} · ${a.config.version ?? "Unknown"}`], ["Configuration hash", a.config.hash ?? "Unknown"],
      ["Approved baseline hash", a.config.baselineHash ?? "Unknown"], ["Unchanged numerical configuration hash", a.config.numericHash ?? "Unknown"],
      ["Evidence revision", a.evidenceRevision], ["Terms revision", a.termsRevision],
    ]} />
    {a.configuration ? <>
      <DataTable caption={savedConfiguration ? "Saved criterion weights" : "Bound current criterion weights"} columns={[{ label: "Criterion / ID" }, { label: "Unchanged weight" }, { label: "Server rating" }, { label: "Evidence" }]} rows={a.configuration.criteria.map((criterion) => [
        `${criterion.label} · ${criterion.id}`, `${criterion.weight}%`, rating(criterion.rating), packet?.criterionEvidenceRefs?.[criterion.id]?.join(", ") || "No criterion-specific refs returned; see source packet",
      ])} />
      <DataTable caption={savedConfiguration ? "Saved aggregate bands" : "Bound current aggregate bands"} columns={[{ label: "Band" }, { label: "Approved minimum" }]} rows={a.configuration.bands.map((band) => [band.id, band.min])} />
      <p className={styles.small}>{savedConfiguration ? "As-assessed arithmetic" : "Bound arithmetic"}: {a.configuration.arithmetic}. Values are the saved assessment's immutable configuration; this screen cannot change or publish them.</p>
    </> : <p className={styles.small}>Weight and band tables not returned for this assessment. Historical v2 values are not substituted.</p>}
    <div className={styles.pairTight}>
      <Kpi hug label="Qualifying posts" context={`${a.packet.publicationDates} publication dates · at least 2 required`}>{a.packet.qualifyingPosts} / 3</Kpi>
      <Kpi hug label="Meaningful-use posts" context="At least 2 qualifying posts must support the assigned brief">{a.packet.meaningfulUsePosts} / 2</Kpi>
    </div>
    <DataTable caption="Server qualification gates" columns={[{ label: "Gate" }, { label: "State" }, { label: "Evidence / unresolved proof" }]} rows={a.gates.map((g) => [g.id, <Badge key={g.id} tone={g.state === "pass" ? "success" : g.state === "fail" ? "warning" : "neutral"}>{g.state}</Badge>, g.reason])} />
    <p>Server score: {a.score ? `weighted ${known(a.score.earned)} / ${known(a.score.max)} · total ${known(a.score.total)} · band ${a.score.band ?? "Unknown"} · ${a.score.unknownCount} unknown criteria` : savedConfiguration ? "Unknown — no bound score returned for this saved assessment" : "Unknown — no bound current score returned"}. Existing weights and aggregate bands remain server-owned; no historical v2 fallback is applied.</p>
    {a.routeEvidence && <RouteEvidence assessment={a} saved={savedConfiguration} />}
    <DataTable caption="Metadata baseline summary" columns={[{ label: "Measure" }, { label: "Source-backed value" }]} rows={[
      ["Recent unpinned coverage", `${a.metadata.sampleSize} / 10 · ${a.metadata.coverage}`], ["Comparable view rows", a.metadata.comparableViewCount],
      ["Median views", known(a.metadata.medianViews)], ["View spread", `${known(a.metadata.minViews)}–${known(a.metadata.maxViews)}`],
      ["Baseline post IDs", a.metadata.postIds.join(", ") || "None returned"], ["Baseline caveats", a.metadata.reasonCodes.join(", ") || "None reported"],
    ]} />
    <DataTable caption="Buyer response sampling summary" columns={[{ label: "Post / status" }, { label: "Observed rows / authors" }, { label: "Sampling and categories" }]} rows={a.comments.map((c) => [
      `${c.postId} · ${c.status}`, `${known(c.rowCount)} rows · ${known(c.uniqueAuthors)} unique authors · ${known(c.unknownAuthorRows)} unknown-author rows`,
      `${c.ordering ?? "Ordering unknown"} · ${known(c.promptedRows)} prompted · ${known(c.creatorRows)} creator · ${known(c.promotionalRows)} promotional · ${c.categoryCounts ? Object.entries(c.categoryCounts).map(([category, count]) => `${category}: ${count}`).join(", ") : "Categories unknown"}${c.reason ? ` · ${c.reason}` : ""}`,
    ])} />
    <DataTable caption="Server video review provenance" columns={[{ label: "Post / completion" }, { label: "Visual / audio method" }, { label: "Actual review coverage" }]} rows={a.reviews.map((r) => [
      `${r.postId} · ${r.status} · like gate ${r.likeGate}`, `${r.visualMethod} / ${r.audioMethod}`, `${r.sampledPointCount} sampled points · ${r.continuousSeconds}s continuous coverage`,
    ])} />
    {packet ? <AgentEvidenceDetails assessment={a} packet={packet} /> : <p>Source packet not returned. Baseline rows, comment text and timestamped source observations remain unavailable.</p>}
    <p className={styles.small}>Sampled points are not continuous watched intervals. Comment questions, prompted replies and reported ownership are not verified Farda orders. Missing audio/comments remain unknown.</p>
    {a.reasonCodes.length > 0 && <p>Unresolved proof: {a.reasonCodes.join(", ")}</p>}
  </div>;
}

function RouteEvidence({ assessment, saved }: { assessment: CreatorAssessment; saved: boolean }) {
  const proof = assessment.routeEvidence!;
  const routeName = proof.route === "website" ? "Website affiliate" : "TikTok Shop";
  return <section aria-label="Checkout evidence" className={styles.stack}>
    <h3>{saved ? "Saved checkout evidence" : "Checkout evidence"}</h3>
    <p>{routeName} · <Badge tone={proof.status === "verified" ? "success" : proof.status === "failed" ? "warning" : "neutral"}>{proof.status === "verified" ? "Provider verified" : proof.status === "failed" ? "Provider check failed" : "Provider proof pending"}</Badge></p>
    <p>Evidence coverage: {proof.coveredWeight}% of configured weight. {assessment.score?.unknownCount ?? "Unknown"} criteria without a rating.</p>
    <p>Source coverage: {proof.confidence.sourceCoverage}. {proof.confidence.completePublicReviews} complete public reviews across {proof.confidence.distinctPublicationDates} dates; {proof.confidence.commentsObservedPosts} posts with inspected comments.</p>
    <DataTable caption="Evidence behind each rating" columns={[{ label: "Criterion" }, { label: "Anchor and source evidence" }]} rows={proof.criteria.map(c => [
      c.id, [c.anchor ?? "Rating unknown", c.rationale, c.sourceRefs.length ? c.sourceRefs.join(", ") : "Source unavailable"].filter(Boolean).join(" · "),
    ])} />
    {proof.sourceRef && <p className={styles.small}>{[proof.provider, proof.programId, proof.programVersion, proof.market, proof.sourceRef, proof.observedAt].filter(Boolean).join(" · ")}</p>}
    {proof.metrics.length ? <DataTable caption="Provider commerce measurements" columns={[{ label: "Source measure" }, { label: "Observed value" }, { label: "Window and coverage" }]} rows={proof.metrics.map(m => [
      `${m.name} · ${m.definition}`, `${m.value.toLocaleString("en-US")} ${m.unit === "count" ? "count" : `minor units (${m.currency})`}`,
      `${m.windowStart} – ${m.windowEnd} · ${m.maturity} · n=${m.sampleSize} · ${m.denominator} · ${m.sourceRef}`,
    ])} /> : <p>Verified commerce measurements are unavailable.</p>}
    {proof.acceptedTerms && <p>Saved offer {proof.acceptedTerms.offerId} · version {proof.acceptedTerms.version} · {proof.acceptedTerms.acceptedRef}</p>}
  </section>;
}

const categoryLabel: Record<string, string> = {
  generalReaction: "General reaction", routineApplication: "Routine application", productUnderstanding: "Product understanding",
  practicalObjection: "Practical objection", purchaseEvaluation: "Purchase evaluation / source ask", promptedKeyword: "Prompted keyword",
  selfReportedOwnership: "Reported ownership",
};

function AgentEvidenceDetails({ assessment, packet }: { assessment: CreatorAssessment; packet: EvidencePacket }) {
  const nativeLikes = (likes: typeof packet.recentPosts[number]["nativeLikes"]) => likes.status === "known" ? `${known(likes.value)} · ${likes.exact ? "exact" : "approximate / rounded"}` : `${likes.status}: ${likes.reason}`;
  return <>
    <DataTable caption="Server-selected recent metadata baseline" columns={[{ label: "Post / publication" }, { label: "Native likes / pinned / paid" }, { label: "Views and comparable basis" }]} rows={assessment.metadata.postIds.map((postId) => {
      const p = packet.recentPosts.find((post) => post.postId === postId);
      return p ? [
        `${p.postId} · ${p.publishedAt ?? "Publication unknown"}`,
        `${nativeLikes(p.nativeLikes)} · pinned ${p.pinned === null ? "unknown" : p.pinned ? "yes" : "no"} · paid ${p.paid}`,
        p.views.status === "known" ? `${known(p.views.value)} · ${p.views.definition} · ${p.views.window}` : `${p.views.status}: ${p.views.reason}`,
      ] : [postId, "Source row not returned", "Unknown"];
    })} />
    <p className={styles.small}>These are the server-selected metadata rows, including ordinary and lower-like posts. Metadata inclusion does not give deep-review or qualifying-post credit.</p>
    {packet.posts.map((post) => <section key={post.postId} className={styles.stack} aria-label={`Source packet ${post.postId}`}>
      <p>{!post.accessObservation || post.accessObservation.state === "permitted" ?
        <a href={post.sourceUrl} target="_blank" rel="noreferrer">{post.postId} · original {post.network} post</a> :
        <span>{post.postId} · {post.network} · original access {post.accessObservation.state}</span>} · Native likes: {nativeLikes(post.nativeLikes)} · Published: {post.publishedAt ?? "Unknown"} · Observed: {post.observedAt}</p>
      <DataTable caption={`Timestamped source review ${post.postId}`} columns={[{ label: "Provenance" }, { label: "Recorded source evidence" }]} rows={[
        ["Review completion / modality", `${post.review.status} · visual ${post.review.visualMethod} · audio ${post.review.audioMethod}`],
        ["Sampled points", post.review.sampledPoints.length ? post.review.sampledPoints.map(formatTime).join(", ") : "None recorded"],
        ["Continuous intervals", post.review.watchedIntervals.length ? post.review.watchedIntervals.map((range) => `${formatTime(range.startSec)}–${formatTime(range.endSec)}`).join(", ") : "None recorded"],
        ["Observed actions", post.review.observedActions.length ? post.review.observedActions.map((action) => `${formatTime(action.atSec)} · ${action.action} · meaningful use ${action.meaningfulUse ? "yes" : "no"}`).join("; ") : "None recorded"],
        ["Narrated claims", post.review.claims.length ? post.review.claims.map((claim) => `${formatTime(claim.atSec)} · ${claim.text} · ${claim.method}`).join("; ") : "None recorded"],
        ["Reviewer inferences", post.review.inferences.join("; ") || "None recorded"], ["Review receipt", post.review.sourceRef ?? "Unknown"],
      ]} />
      {post.comments.status === "observed" ? <>
        <p className={styles.small}>Comment sample: {post.comments.ordering} · observed {post.comments.observedAt}. Convenience sample; tags can overlap.</p>
        <DataTable caption={`Observed comment rows ${post.postId}`} columns={[{ label: "Comment / author" }, { label: "Source text" }, { label: "Flags / response tags" }]} rows={post.comments.rows.map((comment) => [
          `${comment.commentId} · ${comment.authorRef && /^author:[0-9a-f]{64}$/.test(comment.authorRef) ? "Author " + comment.authorRef.slice(7,15) : "Author unknown"}`, comment.text,
          `${comment.creator ? "Creator" : "Audience"} · ${comment.promotional ? "promotional" : "not flagged promotional"} · ${comment.prompted ? "prompted" : "not prompted"} · ${comment.categories.map((tag) => categoryLabel[tag] ?? tag).join(", ")}`,
        ])} />
      </> : <p>Comments {post.comments.status}: {post.comments.reason}. Response categories and author counts remain unknown.</p>}
    </section>)}
  </>;
}

