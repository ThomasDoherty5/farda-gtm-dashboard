import { NavLink, Outlet } from "react-router-dom";
import { DemoBanner } from "./DemoBanner";
import { navSections } from "@/routes/nav";
import styles from "./Shell.module.css";

/** Semantic application shell: skip link, horizontal primary nav, main landmark. Visual design PENDING Figma. */
export function Shell() {
  return (
    <>
      <a className="skip-link" href="#main">Skip to main content</a>
      <DemoBanner />
      <header className={styles.header}>
        <span className={styles.brand}>Farda GTM</span>
        <nav aria-label="Primary">
          <ul className={styles.nav}>
            {navSections.map((s) => (
              <li key={s.path}>
                <NavLink to={s.path} className={({ isActive }) => (isActive ? styles.active : undefined)}>{s.label}</NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" tabIndex={-1} className={styles.main}>
        <Outlet />
      </main>
    </>
  );
}
