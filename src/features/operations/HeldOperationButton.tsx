import type { ComponentProps } from "react";
import { Button } from "@/components/Button";
import styles from "./Operations.module.css";
/** A control and its visible explanation remain one layout item. */
export function HeldOperationButton(props: ComponentProps<typeof Button>) {
  return <span className={styles.heldControl}><Button {...props} /></span>;
}
