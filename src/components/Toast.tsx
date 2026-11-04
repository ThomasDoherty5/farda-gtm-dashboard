import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import styles from "./Toast.module.css";

/**
 * Toast (Figma component set 6:710: Success, Error). A short confirmation that something *already happened*:
 * a success toast is raised only after the authoritative acknowledgment, never on submit. Success is polite
 * and clears itself; an error is an alert and stays until dismissed, because a missed failure is worse than
 * a lingering one.
 */
export type ToastState = "success" | "error";

export function Toast({ state, children, onDismiss }: { state: ToastState; children: ReactNode; onDismiss?: () => void }) {
  return (
    <div className={`${styles.toast} ${state === "error" ? styles.error : styles.success}`} role={state === "error" ? "alert" : "status"} data-state={state}>
      <p>{children}</p>
      {onDismiss && <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label="Dismiss notification">Dismiss</button>}
    </div>
  );
}

type Item = { id: number; state: ToastState; message: string };
type Api = { notify: (state: ToastState, message: string) => void };
const ToastContext = createContext<Api | null>(null);

export const SUCCESS_TOAST_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((all) => all.filter((i) => i.id !== id)), []);
  const notify = useCallback((state: ToastState, message: string) => {
    const id = next.current++;
    setItems((all) => [...all, { id, state, message }]);
    if (state === "success") setTimeout(() => dismiss(id), SUCCESS_TOAST_MS);
  }, [dismiss]);
  const api = useMemo(() => ({ notify }), [notify]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.region} aria-label="Notifications">
        {items.map((i) => <Toast key={i.id} state={i.state} onDismiss={() => dismiss(i.id)}>{i.message}</Toast>)}
      </div>
    </ToastContext.Provider>
  );
}

/** Raises a toast. Outside a provider it does nothing, so a component can be rendered alone in a test. */
export function useToast(): Api {
  return useContext(ToastContext) ?? { notify: () => undefined };
}
