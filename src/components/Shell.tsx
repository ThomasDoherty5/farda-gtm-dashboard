import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useScope } from "@/adapter/scope";
import { primaryNav, workspaceLinks } from "@/routes/nav";
import { Badge } from "./Badge";
import { Button, LinkButton } from "./Button";
import { Dialog } from "./Dialog";
import styles from "./Shell.module.css";

/** Application shell (Figma 10:218): skip link, horizontal navigation, workspace menu and main landmark. */
export function Shell() {
  const { adapter } = useScope();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const section = pathname.split("/")[1] ?? "";
  const demo = adapter.environment === "demo";

  return (
    <div className={styles.canvas}>
      <a className="skip-link" href="#main">Skip to main content</a>
      <div className={styles.frame}>
        <header className={styles.header}>
          <span className={styles.brand}><span className={styles.mark} aria-hidden="true">f</span>farda</span>
          <nav aria-label="Primary">
            <ul className={styles.nav}>
              {primaryNav.map((item) => {
                const inSection = (item.sections as readonly string[]).includes(section);
                const onPage = inSection && pathname === item.to.split("?")[0];
                return (
                  <li key={item.label}>
                    <Link to={item.to} className={styles.navItem} style={{ minWidth: item.width }} aria-current={onPage ? "page" : inSection ? "true" : undefined}>{item.label}</Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <span className={styles.spacer} />
          {demo && <Badge tone="violet" width={132} testId="demo-banner">Demo workspace</Badge>}
          <button type="button" className={styles.profile} aria-haspopup="dialog" aria-label="Open workspace menu" onClick={() => setMenuOpen(true)}>{demo ? "TD" : "Menu"}</button>
        </header>
        <main id="main" tabIndex={-1} className={styles.main}>
          <Outlet />
        </main>
      </div>
      <Dialog open={menuOpen} title="Explore the Farda workspace." badge={demo ? "Demo" : undefined} onClose={() => setMenuOpen(false)}>
        <p>Choose a workflow.{demo ? " All views use illustrative data." : ""}</p>
        {workspaceLinks.map((link) => <LinkButton key={link.label} to={link.to} onClick={() => setMenuOpen(false)}>{link.label}</LinkButton>)}
        <Button variant="secondary" onClick={() => setMenuOpen(false)}>Close menu</Button>
      </Dialog>
    </div>
  );
}
