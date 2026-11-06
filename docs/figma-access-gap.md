# Figma access

Handoff section 5 requires Figma MCP. This records which file works and what that does and doesn't prove.

## Original source verification for THO-292 and THO-306

The November 5 shared-shell and responsive audit read the original file `UkX7Vy6r5BGgYvUCAi6Pmd`. It inspected the shared component page, resolved token and text-style values, and captured the original Operations mobile (12:653), tablet (12:708) and Recovery (12:534) frames. The design map records the implementation mapping. Earlier comparisons retain the file keys recorded with their measurements.

## November 3 copy-based verification

| File | Key | MCP access |
| -- | -- | -- |
| Original (the handoff's source) | `UkX7Vy6r5BGgYvUCAi6Pmd` | Refused: "no edit access" |
| Copy on the UCSC account | `z9knjMdQ3kxL6Fblvu1tKc` | Works, with a Full seat on a student plan |

Node IDs in the source manifest worked on the copy for every node read so far.

## Limits of using a copy

- It won't pick up later changes to the original. Before relying on a screen, check with the design owner that the copy is still current, or refresh it.
- Comparison evidence must name the copy's key. It isn't proof against the original until someone confirms they match.
- Code Connect is unavailable, because it needs an Organization or Enterprise plan. Component mappings are by hand in `design-map.md`.

## To remove the limit

Have the file owner share the original with an account that has a Dev or Full seat, then point this document back at it.
