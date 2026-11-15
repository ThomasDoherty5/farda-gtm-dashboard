/**
 * Synthetic J20 fixtures only. Every creator, post, URL, receipt and count here is fictional, and nothing here is a
 * source observation. `*.testkit.ts` files are excluded from the production API image (see `.dockerignore`).
 */
import {
  J20_TAXONOMY_VERSION, type EvidenceReview, type LifestyleContext, type PostEvidence, type PostMetric,
} from "../evidence.ts";

export const J20_FIXTURE_AT = "2026-11-08T12:00:00.000Z";
const at = J20_FIXTURE_AT;

export function fixtureContext(overrides: Partial<LifestyleContext> = {}): LifestyleContext {
  return { taxonomyVersion: J20_TAXONOMY_VERSION, primaryBucket: "travelPurse", secondaryLabels: [], exclusion: null,
    educatorOrCredentialed: null, selectionReason: "ordinaryRecent", pinned: false, paid: "no", ...overrides };
}
export function fixtureMetric(key: PostMetric["key"], value: number | null, overrides: Partial<PostMetric> = {}): PostMetric {
  return { key, value, rawLabel: value === null ? "Hidden" : String(value), approximate: false, unit: "count",
    definition: `synthetic native ${key} v1`, window: "lifetime at snapshot", observedAt: at, sourceType: "nativePublicCounter",
    sourceRef: `synthetic:counter:${key}`, missingReason: value === null ? "hidden" : null, ...overrides };
}

const timing = { durationSeconds: 30, playbackElapsedSeconds: 30 as number | null, interruption: null, narration: [] };
const base = { reviewerRef: "synthetic-reviewer", reviewedAt: at, claims: [], inferences: [] };
const shownUse = (atSec: number) => ({ atSec, action: "Places a fictional case into a tote and zips it closed.", meaningfulUse: true, kind: "handlingOperationUse" as const });
/** The six J20-02 modality fixtures. Each is a distinct, honest review: none claims coverage it did not observe. */
export const fixtureReviews = {
  complete: { ...base, ...timing, status: "complete", visualMethod: "continuous", audioMethod: "heard", sampledPoints: [],
    watchedIntervals: [{ startSec: 0, endSec: 30 }], heardIntervals: [{ startSec: 0, endSec: 30 }],
    observedActions: [{ atSec: 0, action: "Opens on a fictional packed tote.", meaningfulUse: false, kind: "hook" }, shownUse(6)], sourceRef: "synthetic:review:complete" },
  sampled: { ...base, ...timing, status: "complete", visualMethod: "sampledFrames", audioMethod: "unassessed", sampledPoints: [0, 5, 10, 20],
    watchedIntervals: [], observedActions: [shownUse(5)], sourceRef: "synthetic:review:sampled" },
  captionOnly: { ...base, ...timing, playbackElapsedSeconds: null, status: "partial", visualMethod: "captionOnly", audioMethod: "nativeCaptions",
    sampledPoints: [], watchedIntervals: [], observedActions: [], sourceRef: null },
  muted: { ...base, ...timing, status: "complete", visualMethod: "continuous", audioMethod: "muted", sampledPoints: [],
    watchedIntervals: [{ startSec: 0, endSec: 30 }], observedActions: [shownUse(6)], sourceRef: "synthetic:review:muted" },
  interrupted: { ...base, ...timing, playbackElapsedSeconds: 12, interruption: { atSec: 12, reason: "Synthetic player stopped." }, status: "partial",
    visualMethod: "continuous", audioMethod: "unassessed", sampledPoints: [], watchedIntervals: [{ startSec: 0, endSec: 12 }], observedActions: [shownUse(6)], sourceRef: null },
  blocked: { ...base, ...timing, playbackElapsedSeconds: null, status: "blocked", visualMethod: "unassessed", audioMethod: "unassessed",
    sampledPoints: [], watchedIntervals: [], observedActions: [], sourceRef: null },
} satisfies Record<string, EvidenceReview>;

/** A J20-collected post with source provenance. `n` keeps native IDs and dates distinct; every value is fictional. */
export function fixtureJ20Post(n: number, review: EvidenceReview = fixtureReviews.complete, overrides: Partial<PostEvidence> = {}): PostEvidence {
  const day = String(Math.min(28, n)).padStart(2, "0");
  return {
    postId: `j20-synthetic-${n}`, canonicalMediaId: `j20-media-synthetic-${n}`, network: "instagram",
    sourceUrl: `https://www.instagram.com/reel/SYNTHJ20${n}/`, publishedAt: `2026-10-${day}T12:00:00.000Z`, observedAt: at,
    accessObservation: { state: "permitted", sourceRef: `synthetic:access:${n}`, observedAt: at },
    relevant: true, nativeLikes: { status: "known", value: 201, exact: true, sourceRef: `synthetic:likes:${n}`, rawLabel: "201" },
    review: structuredClone(review),
    comments: { status: "unknown", reason: "Synthetic comments not inspected." },
    source: { route: "publicNativeUi", providerAccountRef: null, permissionRef: "synthetic:permission", permissionCheckedAt: at, retrievedAt: at,
      contentFingerprint: `synthetic-fingerprint-${n}`, change: "firstObserved", evidenceRefs: [`synthetic:read:${n}`] },
    context: fixtureContext(), metrics: [fixtureMetric("views", 1000 + n), fixtureMetric("shares", null)],
    productionChoices: [], shoppableContext: { status: "unknown", productRef: null, anchorEvidenceRef: null, observedAt: null },
    ...overrides,
  };
}
