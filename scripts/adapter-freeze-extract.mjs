// Extracts every view key, action kind, operation, resource kind and error code that the front end currently
// assumes, from the source (not from any document). docs/adapter-freeze-register.md must list all of them;
// src/adapter/freezeRegister.test.ts fails when one is missing. Deterministic: no network, no clock, sorted output.
//
//   node scripts/adapter-freeze-extract.mjs            human-readable usage map
//   node scripts/adapter-freeze-extract.mjs --json     machine-readable (used by the test)
//
// Scanned: src/adapter/*.ts, src/features/**, src/fixtures/** (test files excluded), plus the catalogues in
// src/adapter/errors.ts and src/adapter/contract.ts. Heuristic by design: a call it cannot read statically
// (a non-literal view key, say) is not seen, so keep keys as string literals at the call site.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Test helpers that live next to the source but are not source: their made-up names ("k", fixture ids) are not part of the contract. */
const TEST_HELPERS = /^(conformance|transportTestKit|acquisitionTestKit)\.(ts|tsx)$|TestKit\.(ts|tsx)$/;

const root = fileURLToPath(new URL("..", import.meta.url));
const SCAN = ["src/adapter", "src/features", "src/fixtures"];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) && !TEST_HELPERS.test(e.name) ? [p] : [];
    });
}

const files = SCAN.flatMap((d) => walk(join(root, d))).map((p) => ({ path: relative(root, p).split("\\").join("/"), text: readFileSync(p, "utf8") }));
const isAdapter = (f) => f.path.startsWith("src/adapter/");
const isFeature = (f) => f.path.startsWith("src/features/");

const out = { operations: {}, views: {}, actionKinds: {}, resourceKinds: {}, nextActionKinds: {}, errorCodes: {}, reasonCodes: {} };
function add(bucket, key, role, file) {
  const entry = (out[bucket][key] ??= {});
  (entry[role] ??= new Set()).add(file);
}
const literals = (s) => [...s.matchAll(/"([A-Za-z][A-Za-z0-9_]*)"/g)].map((m) => m[1]);

/** The text of the `{ ... }` block that starts at the first `{` at or after `from`. */
function block(text, from) {
  const open = text.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return "";
}

/** The `case "x":` labels that sit directly in the switch (depth 1), not in nested blocks. */
function switchCases(text, header) {
  const found = [];
  for (let at = text.indexOf(header); at !== -1; at = text.indexOf(header, at + 1)) {
    const body = block(text, at);
    let depth = 0;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}") depth--;
      else if (depth === 1 && body.startsWith("case ", i)) {
        const m = /^case\s+"([A-Za-z0-9_]+)"\s*:/.exec(body.slice(i));
        if (m) found.push(m[1]);
      }
    }
  }
  return found;
}

for (const f of files) {
  const { text, path } = f;

  // View keys: a screen reads one with useView("key", ...); a handler answers it.
  if (isFeature(f)) for (const m of text.matchAll(/useView<[^(]*?\(\s*"(\w+)"/g)) add("views", m[1], "readBy", path);
  if (isAdapter(f)) {
    for (const m of text.matchAll(/viewKey\s*[!=]==\s*"(\w+)"/g)) add("views", m[1], "handledBy", path);
    for (const k of switchCases(text, "switch (request.viewKey)")) add("views", k, "handledBy", path);
    for (const m of text.matchAll(/(?:analytics|monitor)ViewKeys\s*=\s*\[([^\]]*)\]/g)) for (const k of literals(m[1])) add("views", k, "handledBy", path);
  }

  // Action kinds, operations and resource kinds. Screens send them; handlers and capabilities name them.
  for (const m of text.matchAll(/actionKind:\s*([^,}\n]*)/g)) {
    let expression = m[1];
    // Follow a local literal/boolean-conditional alias used by shared forms. Do not
    // guess dynamic values or include unrelated strings from later declarations.
    if (/^\s*\w+\s*$/.test(expression)) {
      const declaration = new RegExp(`\\b(?:const|let)\\s+${expression.trim()}\\s*=\\s*([^;\\n]+)`).exec(text)?.[1]?.split(",")[0]?.trim();
      if (declaration && /^(?:[\w.!]+\s*\?\s*)?"\w+"(?:\s*:\s*"\w+")?$/.test(declaration)) expression = declaration;
    }
    for (const k of literals(expression.replace(/\w+\s*===\s*"[^"]*"/g, ""))) add("actionKinds", k, isFeature(f) && /operation:|\{ key:/.test(lineOf(text, m.index)) ? "sentBy" : "namedBy", path);
  }
  for (const m of text.matchAll(/actionKind\s*[!=]==\s*"(\w+)"/g)) add("actionKinds", m[1], "namedBy", path);
  for (const m of text.matchAll(/blockedReason\(\s*\w+,\s*"(\w+)"/g)) add("actionKinds", m[1], "namedBy", path);
  for (const m of text.matchAll(/\[([^\]]*)\]\.includes\(request\.actionKind\)/g)) for (const k of literals(m[1])) add("actionKinds", k, "handledBy", path);
  for (const m of text.matchAll(/COMMANDS:\s*readonly string\[\]\s*=\s*\[([^\]]*)\]/g)) for (const k of literals(m[1])) add("actionKinds", k, "handledBy", path);
  // RunPage sends the reconcile request name as its action kind (actionKind: request).
  for (const m of text.matchAll(/type ReconcilePayload\s*=\s*\{[^}]*request:\s*([^}]*)\}/g)) for (const k of literals(m[1])) add("actionKinds", k, "sentBy", "src/features/approvals/RunPage.tsx");
  for (const m of text.matchAll(/operation:\s*"(\w+)"/g)) if (m[1] !== "readView" && m[1] !== "saveResource") add("operations", m[1], isFeature(f) ? "sentBy" : "namedBy", path);
  for (const k of switchCases(text, "switch (request.operation)")) add("operations", k, "handledBy", path);
  for (const m of text.matchAll(/resourceKind:\s*"(\w+)"/g)) add("resourceKinds", m[1], isFeature(f) ? "sentBy" : "namedBy", path);
  for (const m of text.matchAll(/resourceKind\s*[!=]==\s*"(\w+)"/g)) add("resourceKinds", m[1], "handledBy", path);
  for (const m of text.matchAll(/nextAction:\s*\{\s*kind:\s*"(\w+)"/g)) add("nextActionKinds", m[1], "returnedBy", path);

  // Error codes: AdapterError bodies, and the fail()/err() helpers (the code is the first argument, possibly a ternary).
  for (const m of text.matchAll(/\bcode:\s*"([A-Z][A-Z0-9_]+)"/g)) add("errorCodes", m[1], "raisedBy", path);
  for (const m of text.matchAll(/\b(?:fail|err)\(\s*((?:"[A-Z][A-Z0-9_]+"|[^"`,()]*?\?\s*"[A-Z][A-Z0-9_]+"\s*:\s*"[A-Z][A-Z0-9_]+"))\s*,/g)) for (const c of m[1].matchAll(/"([A-Z][A-Z0-9_]+)"/g)) add("errorCodes", c[1], "raisedBy", path);

  // Reason codes (informational; not drift-tested): free strings on responses, capabilities and coverage.
  if (isAdapter(f)) {
    for (const m of text.matchAll(/reasonCodes:\s*([^\n]*)/g)) for (const c of m[1].matchAll(/"([A-Z][A-Z0-9_]{3,})"/g)) add("reasonCodes", c[1], "usedBy", path);
    for (const m of text.matchAll(/\b(?:response|respond|actionResponse)\(\s*request,\s*(?:"\w+"|[^,]+\?[^,]+),\s*\[([^\]]*)\]/g)) for (const c of m[1].matchAll(/"([A-Z][A-Z0-9_]{3,})"/g)) add("reasonCodes", c[1], "usedBy", path);
  }
}

function lineOf(text, index) {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? undefined : end);
}

// The catalogue in errors.ts: code -> category.
const errorsTs = readFileSync(join(root, "src/adapter/errors.ts"), "utf8");
const catalogue = {};
for (const m of errorsTs.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):\s*"(\w+)",/gm)) {
  catalogue[m[1]] = m[2];
  add("errorCodes", m[1], "catalogue", "src/adapter/errors.ts");
}
out.categories = [...errorsTs.matchAll(/\|\s*"(\w+)"/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).sort();
out.catalogue = catalogue;

// Contract-defined operations and resource kinds (src/adapter/contract.ts).
const contract = readFileSync(join(root, "src/adapter/contract.ts"), "utf8");
for (const m of contract.match(/actionOperations\s*=\s*\[([^\]]*)\]/)?.[1].matchAll(/"(\w+)"/g) ?? []) add("operations", m[1], "contract", "src/adapter/contract.ts");
for (const m of contract.match(/resourceKind:\s*([^;]*);/)?.[1].matchAll(/"(\w+)"/g) ?? []) add("resourceKinds", m[1], "contract", "src/adapter/contract.ts");

const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([r, s]) => [r, [...s].sort()]))]));
const result = { ...out, operations: sorted(out.operations), views: sorted(out.views), actionKinds: sorted(out.actionKinds), resourceKinds: sorted(out.resourceKinds), nextActionKinds: sorted(out.nextActionKinds), errorCodes: sorted(out.errorCodes), reasonCodes: sorted(out.reasonCodes) };

if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else {
  for (const bucket of ["operations", "views", "actionKinds", "resourceKinds", "nextActionKinds", "errorCodes", "reasonCodes"]) {
    console.log(`\n## ${bucket} (${Object.keys(result[bucket]).length})`);
    for (const [key, roles] of Object.entries(result[bucket])) console.log(`${key}\n${Object.entries(roles).map(([r, s]) => `    ${r}: ${s.map((p) => p.replace(/^src\//, "")).join(", ")}`).join("\n")}`);
  }
}
