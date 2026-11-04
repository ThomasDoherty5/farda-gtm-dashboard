import { useEffect, useRef, useState, type RefObject } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useScope } from "@/adapter/scope";
import { primaryNav, sectionOf, workspaceLinks } from "@/routes/nav";
import { Badge } from "./Badge";
import { Button, LinkButton } from "./Button";
import { Dialog } from "./Dialog";
import styles from "./Shell.module.css";

/** Navigation items kept in the header at tablet width (Figma 12:710); the rest move into "More". */
const TABLET_ITEMS = 4;
const SITE_TITLE = "Farda GTM Operations";

/**
 * Route changes (WCAG 2.4.2, 2.4.3, 4.1.3): the document title names the page, and after navigating focus moves to the page heading,
 * or to main while the heading is still loading, so keyboard and screen-reader users start at the top of the new page.
 * The first load keeps the browser's own focus. Query-only changes (tabs, filters) do not move focus.
 */
function useRouteAnnouncement(main: RefObject<HTMLElement>, pathname: string) {
  const shown = useRef(pathname);
  const pending = useRef(false);
  useEffect(() => {
    const el = main.current;
    if (!el) return;
    const heading = () => el.querySelector<HTMLElement>("h1");
    const syncTitle = () => { const text = heading()?.textContent?.trim(); document.title = text ? `${text} · Farda` : SITE_TITLE; };
    const focusHeading = () => {
      const target = heading() ?? el;
      if (target !== el) target.tabIndex = -1;
      target.focus();
      return target !== el;
    };
    syncTitle();
    if (shown.current !== pathname) {
      shown.current = pathname;
      pending.current = !focusHeading();
    }
    const observer = new MutationObserver(() => {
      syncTitle();
      // The heading arrived after the navigation: move focus only if the user has not moved it on.
      if (pending.current && heading() && (document.activeElement === el || document.activeElement === document.body)) pending.current = !focusHeading();
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    const stop = window.setTimeout(() => { pending.current = false; }, 3000);
    return () => { observer.disconnect(); window.clearTimeout(stop); };
  }, [main, pathname]);
}

/** Application shell (Figma 10:218): skip link, horizontal navigation, workspace menu and main landmark. */
export function Shell() {
  const { adapter } = useScope();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  useRouteAnnouncement(mainRef, pathname);
  const section = sectionOf(pathname);
  const demo = adapter.environment === "demo";

  return (
    <div className={styles.canvas}>
      <a className="skip-link" href="#main">Skip to main content</a>
      <div className={styles.frame}>
        <header className={styles.header}>
          <span className={styles.brand}><span className={styles.mark} aria-hidden="true">f</span>farda</span>
          <nav aria-label="Primary" className={styles.primary}>
            <ul className={styles.nav}>
              {primaryNav.map((item, index) => {
                const inSection = (item.sections as readonly string[]).includes(section);
                const onPage = inSection && pathname === item.to.split("?")[0];
                return (
                  <li key={item.label} className={index >= TABLET_ITEMS ? styles.overflowItem : undefined}>
                    <Link to={item.to} className={styles.navItem} style={{ minWidth: item.width }} aria-current={onPage ? "page" : inSection ? "true" : undefined}>{item.label}</Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          {/* Figma 12:708 ends the 1024 navigation in "More"; 12:653 replaces it with "Menu" at 390. Both open the workspace menu, which lists every section. */}
          <button type="button" className={`${styles.navItem} ${styles.more}`} aria-haspopup="dialog" onClick={() => setMenuOpen(true)}>More</button>
          <button type="button" className={styles.menuButton} aria-haspopup="dialog" onClick={() => setMenuOpen(true)}>Menu</button>
          <span className={styles.spacer} />
          {demo && <Badge tone="violet" width={132} testId="demo-banner">Demo workspace</Badge>}
          <button type="button" className={styles.profile} aria-haspopup="dialog" aria-label="Open workspace menu" onClick={() => setMenuOpen(true)}>{demo ? "TD" : "Menu"}</button>
        </header>
        <main id="main" ref={mainRef} tabIndex={-1} className={styles.main}>
          <Outlet />
        </main>
      </div>
      <Dialog open={menuOpen} title="Explore the Farda workspace." badge={demo ? "Demo" : undefined} onClose={() => setMenuOpen(false)}>
        <p>Choose a workflow.{demo ? " All views use illustrative data." : ""}</p>
        {/* Below 1180px the header shows fewer sections, so the menu lists them all. */}
        <nav aria-label="Sections" className={styles.sections}>
          <ul>
            {primaryNav.map((item) => {
              const inSection = (item.sections as readonly string[]).includes(section);
              return <li key={item.label}><LinkButton to={item.to} variant={inSection ? "primary" : "secondary"} aria-current={inSection ? "true" : undefined} onClick={() => setMenuOpen(false)}>{item.label}</LinkButton></li>;
            })}
          </ul>
        </nav>
        {workspaceLinks.map((link) => <LinkButton key={link.label} to={link.to} onClick={() => setMenuOpen(false)}>{link.label}</LinkButton>)}
        <Button variant="secondary" onClick={() => setMenuOpen(false)}>Close menu</Button>
      </Dialog>
    </div>
  );
}
