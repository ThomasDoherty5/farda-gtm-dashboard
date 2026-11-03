import { useId, type ReactNode } from "react";
import styles from "./Field.module.css";

/** Input (Figma component set 6:404): label, field, then help or error text. Errors are tied to the field and announced. */
type Common = { label: string; helpText?: string | undefined; error?: string | null | undefined; children: (props: { id: string; "aria-invalid": boolean; "aria-describedby"?: string; className: string }) => ReactNode };

export function Field({ label, helpText, error, children }: Common) {
  const id = useId();
  const messageId = `${id}-message`;
  const message = error ?? helpText;
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>{label}</label>
      {children({ id, "aria-invalid": Boolean(error), "aria-describedby": message ? messageId : undefined, className: styles.control ?? "" })}
      {message && <p id={messageId} className={error ? styles.error : styles.help} role={error ? "alert" : undefined}>{message}</p>}
    </div>
  );
}

export function TextField({ label, helpText, error, value, onChange, placeholder, multiline = false, rows = 3 }: { label: string; helpText?: string; error?: string | null; value: string; onChange: (value: string) => void; placeholder?: string; multiline?: boolean; rows?: number }) {
  return (
    <Field label={label} helpText={helpText} error={error}>
      {(props) =>
        multiline ? (
          <textarea {...props} rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <input {...props} type="text" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        )
      }
    </Field>
  );
}

export function SelectField({ label, helpText, error, value, onChange, options }: { label: string; helpText?: string; error?: string | null; value: string; onChange: (value: string) => void; options: { value: string; label: string }[] }) {
  return (
    <Field label={label} helpText={helpText} error={error}>
      {(props) => (
        <select {...props} value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </Field>
  );
}
