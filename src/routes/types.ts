/** One native Figma source screen and its proposed route (handoff section 6). */
export type SourceScreen = {
  /** Owning Linear frontend issue, e.g. "THO-293". */
  owner: string;
  screen: string;
  /** Source node: the implementation authority. */
  sourceNodeId: string;
  /** Prototype clone: interaction reference only. */
  prototypeNodeId: string;
  /** Proposed path pattern. Several sources can share one path (tabs, states, variants). */
  path: string;
  /** Query values that select this source on a shared path. */
  query: Record<string, string>;
  /** Free-text variant note from the handoff, e.g. "390px" or "CONTENT-v2 history". */
  variant: string | null;
  scope: string;
};
