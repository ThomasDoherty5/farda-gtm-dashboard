import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from "react";
import { useLocation, useNavigate, useRouteError } from "react-router-dom";
import { Badge } from "./Badge";
import { Button, LinkButton } from "./Button";
import styles from "./RenderError.module.css";

/**
 * Failure state for a screen that threw while rendering (for example a shape the contract did not promise).
 * It replaces the whole screen, so no stale or partial data stays visible, and it never prints the error:
 * messages and stacks can carry provider data. Developers get the error in the console in development only.
 * The label says "Error"; nothing here reads as a success, an empty result or a zero.
 */
function logRenderError(source: string, error: unknown) {
  if (import.meta.env.DEV) console.error(`[render error: ${source}]`, error);
}

const reload = () => window.location.reload();

function Panel({ actions }: { actions: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  // The screen the user was on is gone, so focus starts at the new top of the page.
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <section role="alert" aria-labelledby="render-error-title" className={styles.panel} data-testid="render-error">
      <Badge tone="danger">Error</Badge>
      <h1 id="render-error-title" ref={heading} tabIndex={-1} className={styles.title}>Something went wrong on this screen</h1>
      <p className={styles.body}>
        The screen stopped before it could finish drawing, so none of its data is shown. Nothing here is a zero or an empty result.
        Other screens are not affected.
      </p>
      <div className={styles.actions}>{actions}</div>
    </section>
  );
}

/** Route-level error element. Rendered inside the shell's main region, so navigation stays available. */
export function RouteError() {
  const error = useRouteError();
  const navigate = useNavigate();
  const { key } = useLocation();
  useEffect(() => { logRenderError("route", error); }, [error]);
  return (
    <Panel
      actions={
        <>
          {/* "default" is the first entry in this session's history, where going back would leave the app. */}
          {key !== "default" && <Button variant="secondary" onClick={() => navigate(-1)}>Go back</Button>}
          <LinkButton to="/overview" variant="secondary">Go to Overview</LinkButton>
          <Button onClick={reload}>Reload</Button>
        </>
      }
    />
  );
}

/** Error element for the shell route itself: the shell is what failed, so this stands alone in its own main region. */
export function ShellError() {
  return <main id="main" className={styles.standalone}><RouteError /></main>;
}

/** Outermost boundary. Catches failures in providers or the router, where no router hooks or links can be relied on. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, _info: ErrorInfo) { logRenderError("app", error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main id="main" className={styles.standalone}>
        <Panel actions={<>
          {window.history.length > 1 && <Button variant="secondary" onClick={() => window.history.back()}>Go back</Button>}
          <Button onClick={reload}>Reload</Button>
        </>} />
      </main>
    );
  }
}
