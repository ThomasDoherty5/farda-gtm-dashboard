import { digest } from "../config.ts";
import {
  MIRRORED_FIELDS, MirrorWriteUncertainError, type AuthoritativeSourceReader, type MirrorRead, type MirrorRow, type MirrorWriteRequest,
  type MirrorWriteIdentity, type MirrorWriteResult, type MirrorWriter, type MirroredFields, type OriginalMirrorAttempt,
  type RecordRef, type SourceRead, type SourceRecord,
} from "./contract.ts";

/** How the fake handles the next write. `ok` applies and acknowledges. */
export type FakeWriteBehaviour =
  /** Times out before applying anything. */
  | "timeout"
  /** Applies, then loses the acknowledgement. */
  | "lostAck"
  /** Another writer edits the row first, so the compare-and-set fails. */
  | "conflict"
  /** Applies only the first field it was asked to set, and acknowledges. */
  | "partial"
  /** The provider refuses the write and applies nothing. */
  | "reject"
  | "ok";
export type FakeHistoryEntry = { version: string; actor: string; changes: Record<string, unknown>; writeKey: string | null };
type Stored = { row: MirrorRow; version: number; history: FakeHistoryEntry[] };

/**
 * A deterministic in-memory mirror for tests. Writes patch only the mirrored fields named in `set` and append to the row's
 * history; local fields and earlier history are never touched by a write. All data is synthetic.
 */
export class FakeMirrorWriter implements MirrorWriter {
  readonly rows = new Map<string, Stored>();
  /** Each write request, without its abort signal, which is kept in `signals`. */
  readonly writes: Omit<MirrorWriteRequest, "signal">[] = [];
  readonly signals: AbortSignal[] = [];
  readonly lookups: string[] = [];
  private readonly attempts = new Map<string, OriginalMirrorAttempt>();
  readonly calls = { read: 0, write: 0, readBack: 0 };
  private behaviours: FakeWriteBehaviour[] = [];
  private failing = { read: 0, readBack: 0 };
  /** Runs before each read or read-back returns, so a test can change the mirror between the service's steps. */
  onRead: ((how: "read" | "readBack", n: number) => void) | null = null;
  private readonly now: () => number;
  readonly maxWriteMs: number;
  constructor(now: () => number, maxWriteMs = 10_000) { this.now = now; this.maxWriteMs = maxWriteMs; }

  private version(n: number) { return `synthetic-mirror-v${n}`; }
  seed(row: MirrorRow, history: FakeHistoryEntry[] = []) {
    this.rows.set(row.key, { row: structuredClone(row), version: 1, history: structuredClone(history) });
  }
  /** An edit by someone other than the resync, such as an operator changing a local note or another sync. */
  edit(key: string, changes: Partial<MirroredFields> & { local?: MirrorRow["local"] }, actor = "synthetic-other-writer") {
    const s = this.rows.get(key)!;
    const { local, ...fields } = changes;
    s.row = { ...s.row, ...fields, local: local ? { ...s.row.local, ...local } : s.row.local };
    s.version++;
    s.history.push({ version: this.version(s.version), actor, changes: structuredClone(changes), writeKey: null });
  }
  next(...behaviours: FakeWriteBehaviour[]) { this.behaviours.push(...behaviours); return this; }
  failReads(n: number) { this.failing.read += n; return this; }
  failReadBacks(n: number) { this.failing.readBack += n; return this; }
  current(key: string) { return this.rows.get(key) ?? null; }

  private snapshot(key: string): MirrorRead {
    const s = this.rows.get(key), observedAt = new Date(this.now()).toISOString();
    const timing = { observedAt, sourceAsOf: observedAt };
    return s ? { state: "found", row: structuredClone(s.row), version: this.version(s.version), ...timing } : { state: "absent", ...timing };
  }
  private async readAs(how: "read" | "readBack", ref: RecordRef): Promise<MirrorRead> {
    const n = ++this.calls[how];
    this.onRead?.(how, n);
    if (this.failing[how] > 0) { this.failing[how]--; return { state: "failed", reason: "SYNTHETIC_READ_FAILED" }; }
    return this.snapshot(ref.recordKey);
  }
  read(ref: RecordRef) { return this.readAs("read", ref); }
  readBack(ref: RecordRef) { return this.readAs("readBack", ref); }
  async lookupOriginal(command: MirrorWriteIdentity): Promise<OriginalMirrorAttempt> {
    this.lookups.push(command.writeKey);
    return this.attempts.get(command.writeKey) ?? { state: "unknown" };
  }

  closeWithoutApply(writeKey: string) {
    const command = this.writes.find(write => write.writeKey === writeKey);
    if (!command || this.attempts.has(writeKey)) throw new Error("Synthetic attempt cannot close as not applied.");
    this.attempts.set(writeKey, { state: "notApplied", writeKey, commandHash: digest(command), receiptRef: "synthetic-closure:" + writeKey,
      observedAt: new Date(this.now()).toISOString(), complete: true, originalAttemptClosed: true });
  }

  async write(request: MirrorWriteRequest): Promise<MirrorWriteResult> {
    this.calls.write++;
    const { signal, ...recorded } = request;
    this.signals.push(signal);
    this.writes.push(structuredClone(recorded));
    if (this.now() > Date.parse(request.deadline)) {
      this.closeWithoutApply(request.writeKey);
      return { state: "rejected", reason: "SYNTHETIC_DEADLINE_EXPIRED" };
    }
    for (const k of Object.keys(request.set)) if (!(MIRRORED_FIELDS as readonly string[]).includes(k)) throw new Error(`Local field in write: ${k}`);
    const behaviour = this.behaviours.shift() ?? "ok";
    if (behaviour === "timeout") throw new MirrorWriteUncertainError("SYNTHETIC_TIMEOUT");
    if (behaviour === "reject") return { state: "rejected", reason: "SYNTHETIC_REJECTED" };
    const key = request.ref.recordKey;
    if (behaviour === "conflict" && this.rows.has(key)) this.edit(key, { local: { synthetic_note: "edited elsewhere" } });
    const s = this.rows.get(key), currentVersion = s ? this.version(s.version) : null;
    if (currentVersion !== request.expectedVersion) return { state: "conflict", currentVersion };
    const entries = Object.entries(request.set), applied = Object.fromEntries(behaviour === "partial" ? entries.slice(0, 1) : entries);
    const { ref } = request;
    const stored: Stored = s ?? { row: { key, scope: ref.scope, grain: ref.grain, period: ref.period, currency: ref.currency, amountMinor: 0, local: {} },
      version: 0, history: [] };
    stored.row = { ...stored.row, ...applied };
    stored.version++;
    stored.history.push({ version: this.version(stored.version), actor: "resync", changes: applied, writeKey: request.writeKey });
    this.rows.set(key, stored);
    this.attempts.set(request.writeKey, { state: "applied", writeKey: request.writeKey, commandHash: digest(recorded),
      version: this.version(stored.version), receiptRef: "synthetic-effect:" + request.writeKey, observedAt: new Date(this.now()).toISOString() });
    if (behaviour === "lostAck") throw new MirrorWriteUncertainError("SYNTHETIC_ACK_LOST");
    return { state: "applied", version: this.version(stored.version) };
  }
}

/** A deterministic authoritative source. `override` replaces the next reads' results; `version` and `observedAt` are adjustable. */
export class FakeSourceReader implements AuthoritativeSourceReader {
  readonly records = new Map<string, SourceRecord>();
  version: string | null = "synthetic-source-v1";
  observedAtOffsetMs = 0;
  reads = 0;
  private overrides: (SourceRead | Error)[] = [];
  private readonly now: () => number;
  constructor(now: () => number) { this.now = now; }
  set(record: SourceRecord) { this.records.set(record.key, structuredClone(record)); return this; }
  override(...results: (SourceRead | Error)[]) { this.overrides.push(...results); return this; }
  async read(ref: RecordRef): Promise<SourceRead> {
    this.reads++;
    const o = this.overrides.shift();
    if (o instanceof Error) throw o;
    if (o) return o;
    const record = this.records.get(ref.recordKey) ?? null;
    const observedAt = new Date(this.now() + this.observedAtOffsetMs).toISOString();
    return { access: "granted", complete: true, record: record ? structuredClone(record) : null, version: this.version, observedAt, sourceAsOf: observedAt };
  }
}
