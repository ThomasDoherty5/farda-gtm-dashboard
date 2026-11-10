// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ACTION_DOMAIN_MATRIX, HANDLER_MATRIX, JOB_IDS, JOB_MATRIX, renderJobMatrixMarkdown, type Coverage, type JobId } from "./jobMatrix.ts";
import { runtimeRegistrationSchema } from "./jobs/runtimeSchema.ts";
import { jobDefinitionSchema } from "./jobs/schema.ts";
import { bulkRegistrationSchema } from "./bulk/contract.ts";
import { createBulkRuntimeRegistration } from "./bulkRuntime.ts";
import { JOB_ID as INTAKE_JOB_ID } from "./intake/contract.ts";
import { offerJobEnvelopeSchema } from "./offers/job.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const agentDir = join(root, "src/creator-agent");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const isFile = (path: string) => existsSync(join(root, path)) && statSync(join(root, path)).isFile();
const byJob = new Map(JOB_MATRIX.map(entry => [entry.job, entry]));
const jobIdPattern = /^J(0[1-9]|1[0-9]|2[01])$/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
}
/** Production creator-agent sources: no tests, testkits or this matrix. */
const sourceFiles = walk(agentDir)
  .filter(path => path.endsWith(".ts") && !/\.test\.ts$|\.testkit\.ts$/.test(path) && !path.endsWith("/jobMatrix.ts"))
  .map(path => relative(root, path).split("\\").join("/"));

function unwrapObject(schema: z.ZodTypeAny): z.AnyZodObject {
  let current = schema;
  while (current instanceof z.ZodEffects) current = current.innerType();
  if (!(current instanceof z.ZodObject)) throw new Error("Expected an object schema.");
  return current;
}

/**
 * Job identities declared in source, found by pattern rather than by a kept list:
 * `jobId: "Jnn..."`, `jobId: z.literal("Jnn")`, `JOB_ID = "Jnn"` and `family: z.enum([...Jnn...])`.
 * A lowercase `jnn-` prefix (provider health job ids) counts as Jnn.
 */
function scanDeclarations(): Map<string, Set<JobId>> {
  const found = new Map<string, Set<JobId>>();
  const add = (file: string, raw: string) => {
    const job = `J${raw}` as JobId;
    if (!found.has(file)) found.set(file, new Set());
    found.get(file)!.add(job);
  };
  for (const file of sourceFiles) {
    const text = read(file);
    for (const m of text.matchAll(/\bjobId\s*:\s*(?:z\.literal\(\s*)?["'`][Jj](\d{2})(?![0-9])/g)) add(file, m[1]!);
    for (const m of text.matchAll(/\bJOB_ID\s*=\s*["'`]J(\d{2})["'`]/g)) add(file, m[1]!);
    for (const m of text.matchAll(/\bfamily\s*:\s*z\.enum\(\s*\[([^\]]*)\]/g))
      for (const j of m[1]!.matchAll(/["'`]J(\d{2})["'`]/g)) add(file, j[1]!);
  }
  return found;
}

/** The registered set, read from the compiled schemas and factories themselves. */
function registeredFromCode(): Set<string> {
  const families = (unwrapObject(runtimeRegistrationSchema).shape.family as z.ZodEnum<[string, ...string[]]>).options
    .filter(family => family !== "registered-business");
  const bulkRegistration = createBulkRuntimeRegistration({ registrationRef: "matrix-check", ownerRef: "matrix-owner", sourceRef: "matrix-source",
    policyVersion: "matrix-policy", budgets: { maxItems: 1, maxSteps: 1, maxAttempts: 1, maxRunMs: 1000, leaseMs: 1000, maxConcurrency: 1, retryBaseMs: 0 } });
  return new Set([...families, INTAKE_JOB_ID, offerJobEnvelopeSchema.shape.jobId.value, bulkRegistrationSchema.shape.jobId.value,
    bulkRegistration.definition.jobId]);
}

/** Domain expressions passed to composeActionDomains in server.ts, e.g. `...(rewardDomain ? [rewardDomain] : [])`. */
function composedDomains(): string[] {
  const server = read("src/creator-agent/server.ts");
  const call = server.match(/composeActionDomains\(\s*options\.actionFoundation\s*,\s*\[([\s\S]*?)\]\s*\)\s*;/);
  if (!call) throw new Error("composeActionDomains call not found in server.ts");
  return [...call[1]!.matchAll(/\?\s*\[\s*([A-Za-z_$][\w$.]*)\s*\]/g)].map(m => m[1]!);
}

const allCoverage = (coverage: { success: Coverage; failure: Coverage; recovery: Coverage }) =>
  [coverage.success, coverage.failure, coverage.recovery];

describe("agent job coverage matrix (E2E-01)", () => {
  it("has exactly one entry per job, J01 to J21, in order", () => {
    expect(JOB_IDS).toHaveLength(21);
    expect(JOB_MATRIX.map(entry => entry.job)).toEqual([...JOB_IDS]);
    for (const job of JOB_IDS) expect(job).toMatch(jobIdPattern);
  });

  it("covers every job the code registers, and marks each of them implemented", () => {
    const registered = registeredFromCode();
    expect(registered.size).toBeGreaterThan(0);
    for (const job of registered) {
      expect(byJob.has(job as JobId), `${job} is registered in code but has no matrix entry`).toBe(true);
      expect(byJob.get(job as JobId)!.status, `${job} is registered in code`).not.toBe("not-implemented");
    }
  });

  it("lists exactly the source files that declare each job identity", () => {
    const scanned = scanDeclarations();
    expect(scanned.size).toBeGreaterThan(0);
    for (const [file, jobs] of scanned) for (const job of jobs) {
      expect(byJob.has(job), `${file} declares ${job}, which has no matrix entry`).toBe(true);
      expect(byJob.get(job)!.declaredIn, `${file} declares ${job}; add it to that job's declaredIn`).toContain(file);
    }
    for (const entry of JOB_MATRIX) for (const file of entry.declaredIn)
      expect(scanned.get(file)?.has(entry.job), `${file} no longer declares ${entry.job}`).toBe(true);
  });

  it("knows every job id that production creator-agent code references", () => {
    for (const file of sourceFiles) for (const m of read(file).matchAll(/(?<![A-Za-z0-9])J(\d{2})(?![0-9])/g))
      expect(byJob.has(`J${m[1]}` as JobId), `${file} references J${m[1]}, which is not in the matrix`).toBe(true);
  });

  it("maps every registered job handler and checks its modules and jobs", () => {
    const handlers = (unwrapObject(jobDefinitionSchema).shape.handler as z.ZodEnum<[string, ...string[]]>).options;
    expect(Object.keys(HANDLER_MATRIX).sort()).toEqual([...handlers].sort());
    for (const [handler, value] of Object.entries(HANDLER_MATRIX)) {
      for (const module of value.modules) {
        expect(isFile(module), `${handler}: missing ${module}`).toBe(true);
        expect(read(module).includes(`"${handler}"`), `${module} does not use ${handler}`).toBe(true);
      }
      for (const job of value.jobs) expect(byJob.get(job)!.status, `${handler} runs ${job}`).not.toBe("not-implemented");
    }
    const families = (unwrapObject(runtimeRegistrationSchema).shape.family as z.ZodEnum<[string, ...string[]]>).options
      .filter(family => family !== "registered-business");
    expect([...HANDLER_MATRIX["registered-source.v1"]!.jobs].sort()).toEqual([...families].sort());
  });

  it("maps every action domain composed by the server", () => {
    const domains = composedDomains();
    expect(domains.length).toBeGreaterThan(0);
    expect(Object.keys(ACTION_DOMAIN_MATRIX).sort()).toEqual([...domains].sort());
    for (const [domain, value] of Object.entries(ACTION_DOMAIN_MATRIX)) {
      expect(isFile(value.module), `${domain}: missing ${value.module}`).toBe(true);
      for (const job of value.jobs) expect(byJob.get(job)!.modules, `${domain} serves ${job}`).toContain(value.module);
    }
  });

  it("points only at files that exist", () => {
    for (const entry of JOB_MATRIX) {
      const paths = [...entry.modules, ...entry.relatedModules, ...entry.contracts, ...entry.declaredIn,
        ...(entry.qaLinks ?? []).flatMap(link => link.files),
        ...allCoverage(entry.coverage).flatMap(coverage => "none" in coverage ? [] : coverage.map(ref => ref.file)),
        ...(entry.ticketEvidence.kind === "repo" ? [entry.ticketEvidence.file] : [])];
      for (const path of paths) expect(isFile(path), `${entry.job}: missing file ${path}`).toBe(true);
    }
  });

  it("cites test titles that exist in their test files, and states every gap", () => {
    for (const entry of JOB_MATRIX) for (const coverage of allCoverage(entry.coverage)) {
      if ("none" in coverage) { expect(coverage.none.trim(), `${entry.job}: a gap needs a reason`).not.toBe(""); continue; }
      expect(coverage.length, `${entry.job}: use { none } for a gap, not an empty list`).toBeGreaterThan(0);
      for (const ref of coverage) {
        expect(ref.file, `${entry.job}: ${ref.file} is not a test file`).toMatch(/\.test\.tsx?$/);
        const text = read(ref.file);
        expect([`"${ref.title}"`, `'${ref.title}'`, `\`${ref.title}\``].some(quoted => text.includes(quoted)),
          `${entry.job}: "${ref.title}" is not a test title in ${ref.file}`).toBe(true);
      }
    }
  });

  it("keeps status, modules and coverage consistent", () => {
    for (const entry of JOB_MATRIX) {
      expect(entry.ticket, entry.job).toMatch(/^THO-\d+$/);
      expect(entry.notes.trim(), entry.job).not.toBe("");
      if (entry.status === "not-implemented") {
        expect(entry.modules, `${entry.job} is not implemented`).toEqual([]);
        expect(entry.declaredIn, `${entry.job} is not implemented`).toEqual([]);
        for (const coverage of allCoverage(entry.coverage)) expect("none" in coverage, `${entry.job} is not implemented`).toBe(true);
      } else expect(entry.modules.length, `${entry.job} needs its implementing modules`).toBeGreaterThan(0);
      for (const module of entry.modules) expect(entry.relatedModules, `${entry.job}: ${module} is listed twice`).not.toContain(module);
    }
    const tickets = JOB_MATRIX.map(entry => entry.ticket);
    expect(new Set(tickets).size).toBe(tickets.length);
  });

  it("confirms repo ticket evidence beside the job id", () => {
    for (const entry of JOB_MATRIX) if (entry.ticketEvidence.kind === "repo") {
      const text = read(entry.ticketEvidence.file);
      expect(text.includes(entry.ticket) && text.includes(entry.job), `${entry.job}: ${entry.ticketEvidence.file} must name ${entry.ticket} and ${entry.job}`).toBe(true);
    }
  });

  it("links the QA31-02/03 scoring checks to J02", () => {
    expect(byJob.get("J02")!.qaLinks).toEqual([{ id: "QA31-02/03",
      files: ["src/creator-agent/policy.test.ts", "src/creator-agent/approvedBaseline.test.ts"] }]);
  });

  // The Linear snapshot is gitignored. Compare the ticket column when a local copy exists.
  const handoff = join(process.env.FARDA_HANDOFF_DIR ?? join(root, ".handoff"), "job-registry.md");
  it.skipIf(!existsSync(handoff))("matches the build index in the local Linear snapshot", () => {
    const index = new Map([...readFileSync(handoff, "utf8").matchAll(/^\|\s*(J\d{2})\s*\|[^|]*\|\s*\[(THO-\d+)\]/gm)].map(m => [m[1]!, m[2]!]));
    expect([...index.keys()]).toEqual([...JOB_IDS]);
    for (const entry of JOB_MATRIX) expect(entry.ticket, entry.job).toBe(index.get(entry.job));
  });

  it("keeps docs/job-matrix.md in sync with the data", () => {
    const rendered = renderJobMatrixMarkdown();
    if (process.env.UPDATE_JOB_MATRIX_DOC === "1") writeFileSync(join(root, "docs/job-matrix.md"), rendered);
    expect(isFile("docs/job-matrix.md"), "run with UPDATE_JOB_MATRIX_DOC=1 to generate docs/job-matrix.md").toBe(true);
    expect(read("docs/job-matrix.md"), "docs/job-matrix.md is stale; run with UPDATE_JOB_MATRIX_DOC=1").toBe(rendered);
  });
});
