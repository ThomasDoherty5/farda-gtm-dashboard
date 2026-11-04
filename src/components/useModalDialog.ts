import { useEffect, useRef } from "react";

/**
 * Opens and closes a native <dialog> as a modal. The browser traps focus, closes on Escape (reported through
 * onCancel, so the owner stays in control of `open`) and returns focus to whatever opened it.
 */
export function useModalDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) ref.current?.showModal?.();
    else ref.current?.close?.();
  }, [open]);
  return {
    ref,
    onCancel: (e: { preventDefault: () => void }) => { e.preventDefault(); onClose(); },
  };
}
