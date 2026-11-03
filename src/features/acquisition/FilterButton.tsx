import { useId, useState } from "react";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import styles from "./Acquisition.module.css";

type Option = { value: string; label: string };

/**
 * A filter that lives in the URL. It shows the current choice on the button, offers only allowed
 * values, and never writes to a source. Choosing applies at once, so Back restores the previous choice.
 */
export function FilterButton({ name, title, options, value, onChange, width }: { name: string; title: string; options: Option[]; value: string; onChange: (value: string) => void; width?: number }) {
  const [open, setOpen] = useState(false);
  const group = useId();
  const current = options.find((o) => o.value === value) ?? options[0]!;
  return (
    <>
      <Button variant="secondary" aria-haspopup="dialog" style={width ? { minWidth: width } : undefined} onClick={() => setOpen(true)}>{name}: {current.label}</Button>
      <Dialog open={open} title={title} onClose={() => setOpen(false)}>
        <fieldset className={styles.options}>
          <legend>{name}</legend>
          {options.map((o) => (
            <label key={o.value} className={styles.option} htmlFor={`${group}-${o.value}`}>
              <input id={`${group}-${o.value}`} type="radio" name={group} checked={o.value === current.value} onChange={() => onChange(o.value)} />
              {o.label}
            </label>
          ))}
        </fieldset>
        <Button onClick={() => setOpen(false)}>Done</Button>
      </Dialog>
    </>
  );
}
