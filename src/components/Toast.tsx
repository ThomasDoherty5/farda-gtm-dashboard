import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import styles from "./Toast.module.css";

/**
 * Toast (Figma component set 6:710: Success, Error). A short confirmation that something *already happened*:
 * a success toast is raised only after the authoritative acknowledgment, never on submit. Success is polite
 * and clears itself after a long, pausable delay (WCAG 2.2.1: 20 seconds, paused while the pointer is over it or focus is inside, restarted in full when that ends, and always dismissible); an error is an alert and stays until dismissed, because a missed failure is worse than
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

export const SUCCESS_TOAST_MS = 20000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((all) => all.filter((i) => i.id !== id)), []);
  const notify = useCallback((state: ToastState, message: string) => {
    const id = next.current++;
    setItems((all) => [...all, { id, state, message }]);
  }, []);
  const api = useMemo(() => ({ notify }), [notify]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.region} aria-label="Notifications">
        {items.map((i) => <TimedToast key={i.id} item={i} onDone={dismiss} />)}
      </div>
    </ToastContext.Provider>
  );
}

/** A toast in the region. A success toast counts down only while nobody is pointing at it or focused inside it. */
function TimedToast({ item, onDone }: { item: Item; onDone: (id: number) => void }) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (item.state !== "success" || held) return;
    const timer = setTimeout(() => onDone(item.id), SUCCESS_TOAST_MS);
    return () => clearTimeout(timer);
  }, [item.id, item.state, held, onDone]);
  return (
    <div onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      <Toast state={item.state} onDismiss={() => onDone(item.id)}>{item.message}</Toast>
    </div>
  );
}

/** Raises a toast. Outside a provider it does nothing, so a component can be rendered alone in a test. */
export function useToast(): Api {
  return useContext(ToastContext) ?? { notify: () => undefined };
}
