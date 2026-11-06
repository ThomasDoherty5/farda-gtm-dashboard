import { useEffect } from "react";
import { useBlocker } from "react-router-dom";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

/** Keep a versioned draft in place until the user explicitly discards it or saves it. */
export function LeaveGuard({ dirty, subject = "approval" }: { dirty: boolean; subject?: string }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && currentLocation.pathname + currentLocation.search !== nextLocation.pathname + nextLocation.search);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return <Dialog open={blocker.state === "blocked"} title="Discard your edits?" onClose={() => blocker.reset?.()}>
    <p>You have unsaved changes on this {subject}.</p>
    <Button onClick={() => blocker.reset?.()}>Keep task</Button>
    <Button variant="secondary" onClick={() => blocker.proceed?.()}>Discard and leave</Button>
  </Dialog>;
}
