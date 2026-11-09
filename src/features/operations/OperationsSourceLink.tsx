import { HeldOperationButton } from "./HeldOperationButton";
import type { NativeOperationsLink } from "@/adapter/viewSchemas/nativeOperations";
import { LinkButton } from "@/components/Button";
import { useSourceLease } from "@/features/commercial/useSourceLease";
export function OperationsSourceLink({ data, kind, targetRef, label, compact = false }: { compact?: boolean; data: unknown; kind: NativeOperationsLink["kind"]; targetRef: string; label: string }) {
  const record = data as { synthetic?: boolean; sourceLinks?: NativeOperationsLink[] };
  const matches = record.sourceLinks?.filter(link => link.kind === kind && link.targetRef === targetRef) ?? [];
  const link = matches.length === 1 ? matches[0] : undefined;
  const leased = useSourceLease(link?.validUntil);
  return record.synthetic === false && link?.state === "verified" && leased && link.url?.startsWith("https://") ? <LinkButton variant="secondary" to={link.url} target="_blank" rel="noopener noreferrer">{label}<span className="visually-hidden"> (external source, opens in a new tab)</span></LinkButton> : <HeldOperationButton variant="secondary" disabledReason={compact ? "Exact source link unavailable. Refresh or ask its owner." : "A current verified destination for this exact source record is unavailable. Refresh source evidence or contact its owner."}>{label}</HeldOperationButton>;
}
