/** A saved source or run keeps its exact identity when used in a route. */
export const evidenceReviewPath = (creatorId: string, evidenceId: string) =>
  `/creators/${encodeURIComponent(creatorId)}/evidence/${encodeURIComponent(evidenceId)}`;

export const creatorAssessmentPath = (creatorId: string, runId: string) =>
  `/creators/${encodeURIComponent(creatorId)}/assessments/${encodeURIComponent(runId)}`;
