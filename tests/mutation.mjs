#!/usr/bin/env node
// Mutation check: revert each fix, prove the guard suite catches it, restore.
//
// This is the answer to the report's sharpest line — 195 assertions stayed green with all three
// agent definitions deleted, because nothing asserted across a boundary. A guard that cannot go
// red is not a guard, so every fix in this wave is listed here with the exact source mutation
// that undoes it and the probe file that must fail.
//
// Run: node tests/mutation.mjs   (~3 min; not part of run.mjs)
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rd = (f) => readFileSync(join(root, f), "utf8");
const wr = (f, t) => writeFileSync(join(root, f), t);

/** file, a description, and the edit that undoes the fix. `probe` must FAIL after it. */
const MUTATIONS = [
  {
    name: "agent definitions are not shipped",
    probe: "probe_install.ts",
    apply: () => renameSync(join(root, "agents"), join(root, "agents.off")),
    undo: () => renameSync(join(root, "agents.off"), join(root, "agents")),
  },
  {
    name: "package.json stops declaring agents/",
    probe: "probe_install.ts",
    file: "package.json",
    mutate: (t) => JSON.stringify({ ...JSON.parse(t), "pi-subagents": undefined }, null, 2),
  },
  {
    name: "queue budgets are neither defaulted nor validated",
    probe: "probe_install.ts",
    file: "store.ts",
    mutate: (t) => t.replace(/  q\.maxFixRounds = budget[\s\S]*?q\.verifyTimeoutMs = budget\("verifyTimeoutMs", q\.verifyTimeoutMs\);\n/, ""),
  },
  {
    name: "runChild drops a completion event that arrives before the launch reply",
    probe: "probe_install.ts",
    file: "rpc.ts",
    mutate: (t) => t.replace("    if (!asyncId) {\n      early.push(raw);\n      return;\n    }", "    if (!asyncId) return;"),
  },
  {
    name: "a block message prints only summary, not the child's error",
    probe: "probe_install.ts",
    file: "driver.ts",
    mutate: (t) => t.replace(/\n    \.\.\.\(o\.error\?\.trim\(\) \? \[`error: \$\{o\.error\.trim\(\)\.slice\(0, 900\)\}`\] : \[\]\),/, ""),
  },
  {
    name: "the stream-ended transport signature is removed",
    probe: "probe_install.ts",
    file: "resilience.ts",
    mutate: (t) => t.replace("  /stream ended without a stop reason/i,\n", "").replace("  /stream (?:ended|terminated) (?:unexpectedly|prematurely|without)/i,\n", ""),
  },
  {
    name: "the supervisor channel root goes back to <tmpdir>/pi-subagents",
    probe: "probe_install.ts",
    file: "resilience.ts",
    mutate: (t) =>
      t.replace(
        /    \.\.\.\(configured \? \[join\(resolve\(configured\), "supervisor-channels"\)\] : \[\]\),\n    join\(tmpdir\(\), `pi-subagents-\$\{tempScopeId\(\)\}`, "supervisor-channels"\),/,
        '    join(tmpdir(), "pi-subagents", "supervisor-channels"),',
      ),
  },
  {
    name: "the test-matrix gate counts table separators as rows",
    probe: "probe_install.ts",
    file: "contract.ts",
    mutate: (t) => t.replace(/\n    \.filter\(\(l\) => !\/\^\\s\*\\\|\?\[\\s:\|-\]\*\\\|\[\\s:\|-\]\*\$\/\.test\(l\)\)/, ""),
  },
  {
    name: "the gitignore preflight is gone",
    probe: "probe_install.ts",
    file: "driver.ts",
    mutate: (t) => t.replace("    if (unignored.length > 0) {", "    if (false && unignored.length > 0) {"),
  },
  {
    name: "check-ignore is queried without a trailing slash",
    probe: "probe_install.ts",
    file: "driver.ts",
    mutate: (t) => t.replace('["check-ignore", "-q", `${p}/`]', '["check-ignore", "-q", p]'),
  },
  {
    name: "the scope gate matches a gap id as a bare substring",
    probe: "probe_audit2.ts",
    file: "contract.ts",
    mutate: (t) => t.replace("      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;", "      return true;"),
  },
  {
    name: "an unparseable verdict re-runs the whole verify gate",
    probe: "probe_audit2.ts",
    file: "driver.ts",
    // Drop the inner audit loop's own retry: fall back to continuing the OUTER loop, which starts
    // with runVerify — the behaviour this fix removed.
    mutate: (t) =>
      t.replace(
        "          auditAttempt++;\n          log(`  audit verdict unparseable (transport) — re-running the auditor only, ${auditAttempt}/${AUDIT_PARSE_RETRIES}`);\n        }",
        "          auditAttempt++;\n          break;\n        }\n        if ((verdict.gaps[0]?.id ?? \"\").trim() === UNPARSEABLE_GAP_ID) continue;",
      ),
  },
  {
    name: "reset no longer refuses while a driver is live",
    probe: "probe_audit2.ts",
    file: "queue_ops.ts",
    mutate: (t) => t.replace("  const live = drivers.get(cwd);\n  if (live) {", "  const live = undefined;\n  if (live) {"),
  },
  {
    name: "a status-less progress patch wipes the pause fields again",
    probe: "probe_audit2.ts",
    file: "store.ts",
    mutate: (t) => t.replace("    ...(status === \"paused\"", "    ...(patch.status === \"paused\""),
  },
  {
    name: "an expired supervisor request is reported as pending",
    probe: "probe_audit2.ts",
    file: "resilience.ts",
    mutate: (t) => t.replace("          if (typeof req.expiresAt === \"number\" && req.expiresAt > 0 && req.expiresAt < Date.now()) continue;", ""),
  },
  {
    name: "prune mistakes a fixer report for the audit verdict",
    probe: "probe_audit2.ts",
    file: "store.ts",
    mutate: (t) =>
      t.replace(
        /  const roundOf = \(f: string\): number => \{[\s\S]*?\n  \};/,
        "  const roundOf = (f: string): number => Number(f.match(/-audit-(\\d+)\\.json$/)?.[1] ?? -1);",
      ),
  },
];

let bad = 0;
for (const m of MUTATIONS) {
  const backup = m.file ? rd(m.file) : null;
  if (m.file) {
    const mutated = m.mutate(backup);
    if (mutated === backup) {
      console.log(`SKIP  ${m.name} — the mutation matched nothing (source drifted; update this file)`);
      bad++;
      continue;
    }
    wr(m.file, mutated);
  } else {
    m.apply();
  }
  let red = false;
  let head = "";
  try {
    execFileSync(process.execPath, [join(root, "tests", m.probe)], { encoding: "utf8", timeout: 240_000 });
  } catch (e) {
    red = true;
    head = String(e.stdout ?? "").split("\n").find((l) => l.startsWith("FAIL")) ?? "(no FAIL line)";
  }
  if (m.file) wr(m.file, backup);
  else m.undo();
  console.log(`${red ? "RED  ✓" : "GREEN ✗"}  ${m.name}${red ? ` — ${head}` : `  (${m.probe} did NOT catch it)`}`);
  if (!red) bad++;
}

// Everything restored: the suite must be green again, or a mutation leaked.
let restored = true;
try {
  execFileSync(process.execPath, [join(root, "tests", "run.mjs")], { encoding: "utf8", timeout: 600_000 });
} catch {
  restored = false;
}
console.log(restored ? "\nrestored: full suite green" : "\nRESTORE FAILED — a mutation leaked, check `git diff`");
console.log(bad === 0 && restored ? "mutation check: every fix is covered by a guard that goes red" : `mutation check: ${bad} uncovered fix(es)`);
process.exit(bad === 0 && restored ? 0 : 1);
