/**
 * Metric derivations allowed in the client for demo fixtures only.
 * Live values come from THO-317/THO-328 metric definitions; screens must not re-derive them.
 */
export type PostCounters = {
  postId: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
};

export type EngagementResult =
  | { state: "known"; ratePct: number; engagements: number; views: number; includedPosts: number; excludedPosts: number }
  | { state: "notApplicable"; reasonCode: "NO_COMPLETE_POSTS" | "ZERO_VIEWS"; includedPosts: 0 | number; excludedPosts: number };

const isComplete = (p: PostCounters) =>
  p.views !== null && p.likes !== null && p.comments !== null && p.shares !== null;

/**
 * Engagement rate = 100 × (likes + comments + shares) / views, summed over the complete subset.
 * Saves are excluded. Missing counters or zero views give N/A, never a full rate or zero.
 */
export function engagementRate(posts: readonly PostCounters[]): EngagementResult {
  const complete = posts.filter(isComplete);
  const excludedPosts = posts.length - complete.length;
  if (complete.length === 0) return { state: "notApplicable", reasonCode: "NO_COMPLETE_POSTS", includedPosts: 0, excludedPosts };
  const views = complete.reduce((s, p) => s + (p.views ?? 0), 0);
  const engagements = complete.reduce((s, p) => s + (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0), 0);
  if (views === 0) return { state: "notApplicable", reasonCode: "ZERO_VIEWS", includedPosts: complete.length, excludedPosts };
  return { state: "known", ratePct: (100 * engagements) / views, engagements, views, includedPosts: complete.length, excludedPosts };
}
