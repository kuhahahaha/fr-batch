import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBatch } from "../driver.ts";

let fails = 0;
const ok = (n: string, c: boolean, extra = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${extra ? ` — ${extra}` : ""}`); if (!c) fails++; };

const repo = mkdtempSync(join(tmpdir(), "fr-batch-repo-"));
mkdirSync(join(repo, "docs"), { recursive: true });
const sh = (cmd: string, args: string[], cwd = repo) => execFileSync(cmd, args, { cwd, encoding: "utf8" });
sh("git", ["init", "-q"]);
sh("git", ["config", "user.email", "t@t"]); sh("git", ["config", "user.name", "t"]);
writeFileSync(join(repo, "docs/FR_x_PLAN.md"), "# FR x\n\n## 5. Tests — the branch matrix\n\n| id | what | proves non-vacuous |\n|---|---|---|\n| T1 | a | edit a |\n| T2 | b | edit b |\n");
writeFileSync(join(repo, "docs/FR_notests_PLAN.md"), "# FR y\n\n## Design\n\nno matrix here\n");
writeFileSync(join(repo, ".gitignore"), ".pi/\n");
sh("git", ["add", "-A"]); sh("git", ["commit", "-qm", "init"]);

const pi: any = {
  exec: async (cmd: string, args: string[], o: any) => {
    try { return { code: 0, stdout: sh(cmd, args, o?.cwd ?? repo), stderr: "" }; }
    catch (e: any) { return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e) }; }
  },
  events: { on: () => () => {}, emit: () => {} },
  appendEntry: () => {},
};
const ctx: any = { cwd: repo, hasUI: false, ui: {} };
const log = () => {};

const writeQueue = (items: any[]) => writeFileSync(join(repo, ".pi/fr-batch/queue.json"),
  JSON.stringify({ armed: true, maxFixRounds: 3, childTimeoutMs: 1000, verifyTimeoutMs: 1000, defaultVerify: ["true"],
    // no outage backoff in the harness: the fake RPC never replies, and the driver is RIGHT to
    // treat that as an outage — with the shipped defaults it would back off for ~15 minutes.
    transient: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, probeUrl: "" }, items }, null, 2));
const writeProgress = (p: any) => writeFileSync(join(repo, ".pi/fr-batch/progress.json"), JSON.stringify(p, null, 2));
mkdirSync(join(repo, ".pi/fr-batch"), { recursive: true });

// 1. a decision-paused item, continued WITHOUT an answer, on a DIRTY tree (as it really is)
writeQueue([{ id: "x", plan: "docs/FR_x_PLAN.md" }]);
writeProgress({ x: { status: "paused", fixRounds: 0, updatedAt: "now", pauseKind: "decision", pausedPhase: "implement", pausedChildId: "run-abc",
  pendingAsk: "  reason: need_decision\n  T10's premise is false: moss.ptex is not in the repo.\n  (A) vendor it (B) drop T5-T9",
  note: "The implement child needs a supervisor decision it is not allowed to guess at." } });
writeFileSync(join(repo, "dirty.txt"), "child work in progress\n");
let out = await runBatch(pi, ctx, { }, log);
ok("continue without answer refuses instead of spawning", /WAITING FOR YOUR DECISION/.test(out), out.split("\n")[0]);
ok("...and restates the question verbatim", out.includes("moss.ptex is not in the repo") && out.includes("(A) vendor it"));
ok("...and names the exact call that unblocks it", out.includes('answer: "<your decision>"'));
ok("...and the dirty tree did NOT trigger the clean-tree refusal", !/working tree is dirty/.test(out));
ok("...and progress is untouched", JSON.parse(readFileSync(join(repo, ".pi/fr-batch/progress.json"), "utf8")).x.status === "paused");

// 2. same item WITH an answer must get past the refusal (it then tries to spawn, which fails here)
out = await runBatch(pi, ctx, { answer: "Vendor the .ptex." }, log);
ok("an answer clears the refusal and the item proceeds", !/WAITING FOR YOUR DECISION/.test(out), out.split("\n").slice(-2).join(" | "));

// 3. a PLAN with no test matrix is blocked before any child, on a clean tree
execFileSync("rm", ["-f", join(repo, "dirty.txt")]); sh("git", ["checkout", "--", "."]);
ok("harness tree is clean before the gate test", sh("git", ["status", "--porcelain"]).trim() === "", JSON.stringify(sh("git", ["status", "--porcelain"])));
writeQueue([{ id: "y", plan: "docs/FR_notests_PLAN.md" }]);
writeProgress({});
out = await runBatch(pi, ctx, {}, log);
ok("no-matrix PLAN is blocked", /STOPPED at y/.test(out) && /has NO tests section/.test(out), out.split("\n")[0]);
ok("...before any child ran", /NOT started/.test(out) && /no child was spawned/.test(out));
ok("...and it is persisted as blocked", JSON.parse(readFileSync(join(repo, ".pi/fr-batch/progress.json"), "utf8")).y.status === "blocked");

// 4. a PLAN with a numbered matrix passes the gate (fails later, at the child spawn)
writeQueue([{ id: "x", plan: "docs/FR_x_PLAN.md" }]);
writeProgress({});
out = await runBatch(pi, ctx, {}, log);
ok("numbered-matrix PLAN passes the gate", !/tests section/.test(out), out.split("\n").slice(0, 3).join(" | "));

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
