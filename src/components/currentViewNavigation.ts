import type { MouseEvent } from "react";

/** Reselecting the current view preserves filters, recovery keys and history.
 * Modified clicks still follow the exact current URL in their chosen context. */
export function currentViewNavigation(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) event.preventDefault();
}
