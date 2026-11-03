import { useId, useState } from "react";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import styles from "./Acquisition.module.css";

type Option = { value: string; label: string };

/**
 * A filter that lives in the URL. It shows the current choice on the button, offers only allowed
 * values, and never writes to a source. `bare` shows only the choice on the button, as Figma's "All homes" does. Choosing applies at once, so Back restores the previous choice.
 */
export function FilterButton({ name, title, options, value, onChange, width, bare = false }: { name: string; title: string; options: Option[]; value: string; onChange: (value: string) => void; width?: number; bare?: boolean }) {
  const [open, setOpen] = useState(false);
  const group = useId();
  const current = options.find((o) => o.value === value) ?? options[0]!;
  return (
    <>
      <Button variant="secondary" aria-haspopup="dialog" aria-label={bare ? `${name}: ${current.label}` : undefined} style={width ? { minWidth: width } : undefined} onClick={() => setOpen(true)}>{bare ? current.label : `${name}: ${current.label}`}</Button>
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
