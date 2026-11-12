// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ACTION_DOMAIN_MATRIX, HANDLER_MATRIX, JOB_IDS, JOB_MATRIX, NON_JOB_IDENTITIES, renderJobMatrixMarkdown, type Coverage, type JobId } from "./jobMatrix.ts";
import { runtimeRegistrationSchema } from "./jobs/runtimeSchema.ts";
import { jobDefinitionSchema } from "./jobs/schema.ts";
import { bulkRegistrationSchema } from "./bulk/contract.ts";
import { createBulkRuntimeRegistration } from "./bulkRuntime.ts";
import { JOB_ID as INTAKE_JOB_ID } from "./intake/contract.ts";
import { offerJobEnvelopeSchema } from "./offers/job.ts";

const MATRIX_FILE = "src/creator-agent/jobMatrix.ts";
const SERVER_FILE = "src/creator-agent/server.ts";
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
 * Literal job identities in source, found by pattern rather than by a kept list:
 * `jobId: "..."`, `jobId: z.literal("...")`, `JOB_ID = "..."` and each `family: z.enum([...])` value.
 * A literal starting `Jnn` or `jnn` (provider health ids are `j14-<capability>`) is job Jnn;
 * any other literal is returned separately so the test can require it to be a known non-job.
 */
function scanDeclarations() {
  const jobs = new Map<string, Set<JobId>>(), others = new Map<string, Set<string>>();
  const put = <K, V>(map: Map<K, Set<V>>, key: K, value: V) => { if (!map.has(key)) map.set(key, new Set()); map.get(key)!.add(value); };
  const add = (file: string, literal: string) => {
    const job = literal.match(/^[Jj](\d{2})(?![0-9])/);
    if (job) put(jobs, file, `J${job[1]}` as JobId); else put(others, literal, file);
  };
  for (const file of sourceFiles) {
    const text = read(file);
    for (const m of text.matchAll(/\bjobId\s*:\s*(?:z\.literal\(\s*)?["'`]([^"'`]*)["'`]/g)) add(file, m[1]!);
    for (const m of text.matchAll(/\bJOB_ID\s*=\s*["'`]([^"'`]*)["'`]/g)) add(file, m[1]!);
    for (const m of text.matchAll(/\bfamily\s*:\s*z\.enum\(\s*\[([^\]]*)\]/g))
      for (const value of m[1]!.matchAll(/["'`]([^"'`]*)["'`]/g)) add(file, value[1]!);
  }
  return { jobs, others };
}

/** The registered set, read from the compiled schemas and factories themselves. */
function registeredFromCode(): Set<string> {
  const families = (unwrapObject(runtimeRegistrationSchema).shape.family as z.ZodEnum<[string, ...string[]]>).options
    .filter(family => !(family in NON_JOB_IDENTITIES));
  const bulkRegistration = createBulkRuntimeRegistration({ registrationRef: "matrix-check", ownerRef: "matrix-owner", sourceRef: "matrix-source",
    policyVersion: "matrix-policy", budgets: { maxItems: 1, maxSteps: 1, maxAttempts: 1, maxRunMs: 1000, leaseMs: 1000, maxConcurrency: 1, retryBaseMs: 0 } });
  return new Set([...families, INTAKE_JOB_ID, offerJobEnvelopeSchema.shape.jobId.value, bulkRegistrationSchema.shape.jobId.value,
    bulkRegistration.definition.jobId]);
}

/** Split at top-level commas, ignoring nested brackets and string contents. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0, quote: string | null = null, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === "\"" || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map(part => part.trim()).filter(Boolean);
}

/** Index of the bracket closing the one at `open`, or -1. */
function closing(text: string, open: number): number {
  let depth = 0, quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === "\"" || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) return i;
  }
  return -1;
}

/** Top-level `cond ? a : b` split, or null. */
function ternary(text: string): [string, string] | null {
  let depth = 0, question = -1, nested = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && c === "?" && text[i + 1] !== "." && text[i + 1] !== "?" && text[i - 1] !== "?") { if (question < 0) question = i; else nested++; }
    else if (depth === 0 && c === ":" && question >= 0) { if (nested) nested--; else return [text.slice(question + 1, i), text.slice(i + 1)]; }
  }
  return null;
}

const EMPTY = new Set(["[]", "undefined", "null"]);
/** Domain keys inside one array element: unconditional, spread, conditional spread, ternary or call. */
function domainKeys(element: string): string[] {
  let text = element.replace(/\s+/g, "");
  const spread = text.startsWith("...");
  if (spread) text = text.slice(3);
  while (text.startsWith("(") && closing(text, 0) === text.length - 1) text = text.slice(1, -1);
  const branches = ternary(text);
  if (branches) return branches.flatMap(branch => domainKeys(spread ? `...${branch}` : branch));
  if (EMPTY.has(text)) return [];
  if (spread) return text.startsWith("[") && closing(text, 0) === text.length - 1
    ? splitTopLevel(text.slice(1, -1)).flatMap(domainKeys) : [`...${text}`];
  const call = text.match(/^([A-Za-z_$][\w$.]*)\(/);
  return [call && closing(text, call[1]!.length) === text.length - 1 ? `${call[1]}(...)` : text];
}

/** Every domain key in the one `composeActionDomains(base, [ ... ])` call in server.ts. */
function composedDomains(): { keys: string[]; problem: string | null } {
  const hint = `Update the domain scan in jobMatrix.test.ts and ACTION_DOMAIN_MATRIX in ${MATRIX_FILE}.`;
  const server = read(SERVER_FILE);
  const calls = [...server.matchAll(/\bcomposeActionDomains\s*\(/g)];
  if (calls.length !== 1) return { keys: [], problem: `Expected one composeActionDomains(...) call in ${SERVER_FILE}, found ${calls.length}. ${hint}` };
  const open = calls[0]!.index! + calls[0]![0].length - 1, end = closing(server, open);
  const args = end < 0 ? [] : splitTopLevel(server.slice(open + 1, end));
  const list = args[1];
  if (args.length !== 2 || !list?.startsWith("[") || closing(list, 0) !== list.length - 1)
    return { keys: [], problem: `composeActionDomains(...) in ${SERVER_FILE} no longer takes an array literal as its second argument. ${hint}` };
  return { keys: splitTopLevel(list.slice(1, -1)).flatMap(domainKeys), problem: null };
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
      expect(byJob.has(job as JobId), `${job} is registered in code but has no entry in ${MATRIX_FILE}`).toBe(true);
      expect(byJob.get(job as JobId)!.status, `${job} is registered in code`).not.toBe("not-implemented");
    }
  });

  it("lists exactly the source files that declare each job identity", () => {
    const { jobs } = scanDeclarations();
    expect(jobs.size).toBeGreaterThan(0);
    for (const [file, ids] of jobs) for (const job of ids) {
      expect(byJob.has(job), `${file} declares ${job}, which has no entry in ${MATRIX_FILE}`).toBe(true);
      expect(byJob.get(job)!.declaredIn, `${file} declares ${job}; add it to that job's declaredIn in ${MATRIX_FILE}`).toContain(file);
    }
    for (const entry of JOB_MATRIX) for (const file of entry.declaredIn)
      expect(jobs.get(file)?.has(entry.job), `${file} no longer declares ${entry.job}`).toBe(true);
  });

  it("flags job-like literals that are not J01 to J21", () => {
    const { others } = scanDeclarations();
    for (const [literal, found] of others) {
      expect(literal in NON_JOB_IDENTITIES, `${[...found].join(", ")} declares job identity "${literal}"; map it to a job or list it in NON_JOB_IDENTITIES in ${MATRIX_FILE}`).toBe(true);
      expect([...found], `"${literal}"`).toContain(NON_JOB_IDENTITIES[literal]!.file);
    }
    for (const literal of Object.keys(NON_JOB_IDENTITIES))
      expect(others.has(literal), `"${literal}" is no longer declared; remove it from NON_JOB_IDENTITIES`).toBe(true);
  });

  it("knows every job id that production creator-agent code references", () => {
    for (const file of sourceFiles) for (const m of read(file).matchAll(/(?<![A-Za-z0-9])J(\d{2})(?![0-9])/g))
      expect(byJob.has(`J${m[1]}` as JobId), `${file} references J${m[1]}, which is not in ${MATRIX_FILE}`).toBe(true);
  });

  it("maps every registered job handler and checks its modules and jobs", () => {
    const handlers = (unwrapObject(jobDefinitionSchema).shape.handler as z.ZodEnum<[string, ...string[]]>).options;
    expect(Object.keys(HANDLER_MATRIX).sort(), `HANDLER_MATRIX in ${MATRIX_FILE} must list every jobDefinitionSchema handler`).toEqual([...handlers].sort());
    for (const [handler, value] of Object.entries(HANDLER_MATRIX)) {
      for (const module of value.modules) {
        expect(isFile(module), `${handler}: missing ${module}`).toBe(true);
        expect(read(module).includes(`"${handler}"`), `${module} does not use ${handler}`).toBe(true);
      }
      for (const job of value.jobs) expect(byJob.get(job)!.status, `${handler} runs ${job}`).not.toBe("not-implemented");
    }
    const families = (unwrapObject(runtimeRegistrationSchema).shape.family as z.ZodEnum<[string, ...string[]]>).options
      .filter(family => !(family in NON_JOB_IDENTITIES));
    expect([...HANDLER_MATRIX["registered-source.v1"]!.jobs].sort()).toEqual([...families].sort());
  });

  it("maps every action domain composed by the server", () => {
    const { keys, problem } = composedDomains();
    expect(problem, problem ?? "").toBeNull();
    expect(keys.length, `No action domains found in ${SERVER_FILE}; check the scan in jobMatrix.test.ts`).toBeGreaterThan(0);
    for (const key of keys)
      expect(key in ACTION_DOMAIN_MATRIX, `${SERVER_FILE} composes action domain \`${key}\`; add it to ACTION_DOMAIN_MATRIX in ${MATRIX_FILE}`).toBe(true);
    for (const key of Object.keys(ACTION_DOMAIN_MATRIX))
      expect(keys, `ACTION_DOMAIN_MATRIX in ${MATRIX_FILE} lists \`${key}\`, which ${SERVER_FILE} no longer composes`).toContain(key);
    for (const [domain, value] of Object.entries(ACTION_DOMAIN_MATRIX)) {
      expect(isFile(value.module), `${domain}: missing ${value.module}`).toBe(true);
      for (const job of value.jobs) expect(byJob.get(job)!.modules, `${domain} serves ${job}`).toContain(value.module);
    }
  });

  it("recognizes unconditional, conditional, ternary and call domain entries", () => {
    expect(domainKeys("rewardDomain")).toEqual(["rewardDomain"]);
    expect(domainKeys("...(a.b ? [a.b] : [])")).toEqual(["a.b"]);
    expect(domainKeys("...(x ? [first, second] : [])")).toEqual(["first", "second"]);
    expect(domainKeys("flag ? one : two")).toEqual(["one", "two"]);
    expect(domainKeys("flag ? one : undefined")).toEqual(["one"]);
    expect(domainKeys("a ?? b")).toEqual(["a??b"]);
    expect(domainKeys("createDomain({ db, scope })")).toEqual(["createDomain(...)"]);
    expect(domainKeys("...extraDomains")).toEqual(["...extraDomains"]);
    expect(splitTopLevel("a, f(b, c), [d, e], 'x,y'")).toEqual(["a", "f(b, c)", "[d, e]", "'x,y'"]);
  });

  it("points only at files that exist", () => {
    for (const entry of JOB_MATRIX) {
      const paths = [...entry.modules, ...entry.relatedModules, ...entry.contracts, ...entry.declaredIn,
        ...(entry.qaLinks ?? []).flatMap(link => link.files),
        ...allCoverage(entry.coverage).flatMap(coverage => "none" in coverage ? [] : coverage.map(ref => ref.file)),
        ...[entry.name, entry.ticket, entry.ownerRole].flatMap(value => value ? [value.source] : [])];
      for (const path of paths) expect(isFile(path), `${entry.job}: missing file ${path}; update ${MATRIX_FILE}`).toBe(true);
    }
    for (const value of Object.values(NON_JOB_IDENTITIES)) expect(isFile(value.file), value.file).toBe(true);
  });

  it("cites test titles that exist in their test files, and states every gap", () => {
    for (const entry of JOB_MATRIX) for (const coverage of allCoverage(entry.coverage)) {
      if ("none" in coverage) { expect(coverage.none.trim(), `${entry.job}: a gap needs a reason`).not.toBe(""); continue; }
      expect(coverage.length, `${entry.job}: use { none } for a gap, not an empty list`).toBeGreaterThan(0);
      for (const ref of coverage) {
        expect(ref.file, `${entry.job}: ${ref.file} is not a test file`).toMatch(/\.test\.tsx?$/);
        const text = read(ref.file);
        expect([`"${ref.title}"`, `'${ref.title}'`, `\`${ref.title}\``].some(quoted => text.includes(quoted)),
          `${entry.job}: "${ref.title}" is not a test title in ${ref.file}; update ${MATRIX_FILE}`).toBe(true);
      }
    }
  });

  it("records names, tickets and owner roles only where a committed file states them", () => {
    for (const entry of JOB_MATRIX) {
      const checks = [["name", entry.name, entry.job], ["ticket", entry.ticket, entry.job], ["owner role", entry.ownerRole, entry.ticket?.value]] as const;
      for (const [field, value, anchor] of checks) {
        if (!value) continue;
        expect(anchor, `${entry.job}: an owner role needs a repo-sourced ticket`).toBeTruthy();
        const text = read(value.source).toLowerCase();
        expect(text.includes(value.value.toLowerCase()) && text.includes(anchor!.toLowerCase()),
          `${entry.job}: ${value.source} must state the ${field} "${value.value}" and ${anchor}`).toBe(true);
      }
      if (entry.ticket) expect(entry.ticket.value, entry.job).toMatch(/^THO-\d+$/);
    }
    const tickets = JOB_MATRIX.flatMap(entry => entry.ticket ? [entry.ticket.value] : []);
    expect(new Set(tickets).size).toBe(tickets.length);
  });

  it("keeps status, modules and coverage consistent", () => {
    for (const entry of JOB_MATRIX) {
      expect(entry.notes.trim(), entry.job).not.toBe("");
      if (entry.status === "not-implemented") {
        expect(entry.modules, `${entry.job} is not implemented`).toEqual([]);
        expect(entry.declaredIn, `${entry.job} is not implemented`).toEqual([]);
        for (const coverage of allCoverage(entry.coverage)) expect("none" in coverage, `${entry.job} is not implemented`).toBe(true);
      } else expect(entry.modules.length, `${entry.job} needs its implementing modules`).toBeGreaterThan(0);
      for (const module of entry.modules) expect(entry.relatedModules, `${entry.job}: ${module} is listed twice`).not.toContain(module);
    }
  });

  it("links the QA31-02/03 scoring checks to J02", () => {
    expect(byJob.get("J02")!.qaLinks).toEqual([{ id: "QA31-02/03",
      files: ["src/creator-agent/policy.test.ts", "src/creator-agent/approvedBaseline.test.ts"] }]);
  });

  it("keeps docs/job-matrix.md in sync with the data", () => {
    const rendered = renderJobMatrixMarkdown();
    if (process.env.UPDATE_JOB_MATRIX_DOC === "1") writeFileSync(join(root, "docs/job-matrix.md"), rendered);
    expect(isFile("docs/job-matrix.md"), "run with UPDATE_JOB_MATRIX_DOC=1 to generate docs/job-matrix.md").toBe(true);
    expect(read("docs/job-matrix.md") === rendered, "docs/job-matrix.md is stale; rerun this test with UPDATE_JOB_MATRIX_DOC=1").toBe(true);
  });
});
