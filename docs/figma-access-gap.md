# Figma access gap

Handoff section 5 says to record the exact missing input when Figma MCP is unavailable, keep building what does not depend on it, and claim no fidelity.

## Status: blocked as of 2026-11-03

Every Figma MCP file tool tried on file `UkX7Vy6r5BGgYvUCAi6Pmd` fails with "you don't have edit access to this file": `create_session`, `get_metadata`, `get_screenshot` and `get_variable_defs`.

The connected account has a View seat on its own Starter team, and the file belongs to another team.

## What unblocks it

The file owner gives this account edit access to the file. If the failure continues after that, the account may also need a paid Dev or Full seat. See Figma's [MCP access rules](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/).

To confirm: `create_session` succeeds and `get_variable_defs` returns values for node `2:69`.

## What is blocked

| Item | Issue |
| -- | -- |
| 45 variables, 21 component sets, 71 variants, instance overrides | THO-292 |
| Shell, Button and Overview visuals and chart geometry | THO-292, THO-293 |
| Layout of the other 58 sources | THO-287 to THO-289, THO-293 to THO-306 |
| Visual comparison baselines | THO-330 |

The Inter text styles in `src/design-system/tokens.css` come from the handoff's table, not from Figma. Every color, space and radius there is a placeholder.

## What to do first once unblocked

1. Run the section 5 intake on Button `2:69` and Overview `10:217`.
2. Replace the pending tokens and write the token and component map.
3. Build and compare the first slice before touching other screens.
