import { backup, DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { digest } from "../../src/creator-agent/config.ts";
import { evidencePacketSchema } from "../../src/creator-agent/evidence.ts";
import { creatorAssessmentSchema } from "../../src/creator-agent/assessmentSchema.ts";

function inspectDatabase(path, expectedScope) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("Backup integrity verification failed.");
    if (db.prepare("SELECT version FROM agent_meta WHERE id=1").get()?.version !== 1) throw new Error("Unsupported backup storage schema.");
    const scope = db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
    if (!scope?.workspace_id || !scope.account_id) throw new Error("Backup scope is missing.");
    if (expectedScope && (scope.workspace_id !== expectedScope.workspaceId || scope.account_id !== expectedScope.accountId)) throw new Error("Backup scope verification failed.");
    const assessmentCount = Number(db.prepare("SELECT COUNT(*) AS count FROM assessments").get().count);
    const requestCount = Number(db.prepare("SELECT COUNT(*) AS count FROM requests").get().count);
    // Bounded application-level restore probe; never print source IDs, packet text or credentials.
    const first = db.prepare("SELECT creator_id,revision,run_id,packet_hash,body FROM assessments ORDER BY creator_id,revision LIMIT 1").get();
    if (first) {
      const record = JSON.parse(String(first.body));
      const packet = evidencePacketSchema.parse(record.packet);
      const assessment = creatorAssessmentSchema.parse(record.assessment);
      if (record.runId !== first.run_id || record.revision !== first.revision || packet.creatorId !== first.creator_id || assessment.creatorId !== first.creator_id || record.packetHash !== first.packet_hash || digest(record.packet) !== first.packet_hash)
        throw new Error("Backup assessment verification failed.");
    }
    db.exec("COMMIT");
    return { storageSchema: 1, assessmentCount, requestCount };
  } finally { db.close(); }
}

/** Opens an isolated restored copy, checking SQLite, scope and a bounded saved-record round trip. */
export async function verifyBackup(path, { expectedScope } = {}) {
  const backupPath = resolve(path);
  if (!existsSync(backupPath) || !statSync(backupPath).isFile()) throw new Error("Backup source file does not exist.");
  const expected = inspectDatabase(backupPath, expectedScope);
  const scratch = mkdtempSync(join(tmpdir(), "farda-agent-restore-"));
  const restoredPath = join(scratch, "restored.sqlite");
  const snapshot = new DatabaseSync(backupPath, { readOnly: true });
  try {
    await backup(snapshot, restoredPath, { rate: 100 });
    chmodSync(restoredPath, 0o600);
    const restored = inspectDatabase(restoredPath, expectedScope);
    if (JSON.stringify(restored) !== JSON.stringify(expected)) throw new Error("Restored backup counts do not match.");
    return { ...restored, restored: true };
  } finally { snapshot.close(); rmSync(scratch, { recursive: true, force: true }); }
}

/** Uses Node's SQLite online-backup API; it never copies a live main file without its WAL state. */
export async function createBackup(sourcePath, destinationPath, { expectedScope } = {}) {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (source === destination || !existsSync(source) || !statSync(source).isFile()) throw new Error("A distinct existing database source is required.");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  // Reserve exclusively: Node's backup API overwrites existing files, so never hand it an operator's old backup.
  let reservation;
  try { reservation = openSync(destination, "wx", 0o600); } catch { throw new Error("Backup destination must be a new writable file."); }
  closeSync(reservation);
  let db;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    db.exec("PRAGMA busy_timeout=5000");
    const pages = await backup(db, destination, { rate: 100 });
    chmodSync(destination, 0o600);
    const verified = await verifyBackup(destination, { expectedScope });
    return { pages, ...verified };
  } catch (error) {
    rmSync(destination, { force: true });
    throw error;
  } finally { db?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node 24 or later is required.");
    process.umask(0o077);
    const [command, source, destination, extra] = process.argv.slice(2);
    const workspaceId = process.env.FARDA_AGENT_WORKSPACE_ID;
    const accountId = process.env.FARDA_AGENT_ACCOUNT_ID;
    if (Boolean(workspaceId) !== Boolean(accountId)) throw new Error("Both expected scope variables must be supplied together.");
    const options = { expectedScope: workspaceId ? { workspaceId, accountId } : undefined };
    let result;
    if (command === "create" && source && destination && !extra) result = await createBackup(source, destination, options);
    else if (command === "verify" && source && !destination) result = await verifyBackup(source, options);
    else throw new Error("Usage: backup.mjs create SOURCE NEW_BACKUP | verify BACKUP");
    console.log(JSON.stringify(result));
  } catch {
    console.error("Creator agent backup/restore verification failed. Check input paths, scope, permissions and available storage; no existing backup is overwritten.");
    process.exitCode = 1;
  }
}
