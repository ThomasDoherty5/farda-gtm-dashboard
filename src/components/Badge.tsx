import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import styles from "./Badge.module.css";

/** Status badge (Figma component set 2:80). The label carries the meaning; color only supports it. */
export type BadgeTone = "neutral" | "violet" | "success" | "warning" | "danger";

type Props = { tone?: BadgeTone; width?: number; to?: string; testId?: string; children: ReactNode };

export function Badge({ tone = "neutral", width, to, testId, children }: Props) {
  const className = `${styles.badge} ${styles[tone]}`;
  const style = width ? { minWidth: `min(${width}px, 100%)` } : undefined;
  if (to) return <Link to={to} className={className} style={style} data-testid={testId}>{children}</Link>;
  return <span className={className} style={style} data-testid={testId}>{children}</span>;
}
