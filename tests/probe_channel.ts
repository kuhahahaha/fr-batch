import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DECISION_DIRECTIVE, INTERCOM_DETACH_MARK, SUPERVISOR_CHANNEL_ROOT, answerAsk, findPendingAsks, formatAsk } from "../resilience.ts";
import { extractTestsSection, planTestGate } from "../contract.ts";
const P = { DECISION_DIRECTIVE, INTERCOM_DETACH_MARK, SUPERVISOR_CHANNEL_ROOT, answerAsk, findPendingAsks, formatAsk, extractTestsSection, planTestGate };

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) fails++;
};

// --- ask channel classification -------------------------------------------
const runId = `probe-${process.pid}`;
const chan = join(P.SUPERVISOR_CHANNEL_ROOT, `${runId}-fr-implementer-0`);
mkdirSync(join(chan, "requests"), { recursive: true });
mkdirSync(join(chan, "replies"), { recursive: true });
const req = (id: string, reason: string, message: string) =>
  writeFileSync(join(chan, "requests", `${id}.json`), JSON.stringify({ reason, message }));

req("net1", "need_decision", "NETWORK_DOWN: fetch failed (ENOTFOUND api.example)");
req("dec1", "need_decision", "PLAN row T10 premise is false: moss.ptex is not in the repo.\nOptions: (A) vendor it, (B) drop T5-T9.");
req("ans1", "need_decision", "already answered, must not show up");
writeFileSync(join(chan, "replies", "ans1.json"), "{}");

const asks = P.findPendingAsks(runId);
ok("finds both unanswered asks, skips answered", asks.length === 2, `got ${asks.length}: ${asks.map((a) => a.requestId).join(",")}`);
ok("network ask classified isNetwork", asks.find((a) => a.requestId === "net1")?.isNetwork === true);
ok("decision ask classified NOT isNetwork", asks.find((a) => a.requestId === "dec1")?.isNetwork === false);
ok("ask of another run is not picked up", P.findPendingAsks("someone-else").length === 0);

const dec = asks.find((a) => a.requestId === "dec1")!;
ok("formatAsk keeps the question verbatim", P.formatAsk(dec).includes("moss.ptex is not in the repo") && P.formatAsk(dec).includes("(A) vendor it"));

P.answerAsk(dec, P.DECISION_DIRECTIVE);
const replyPath = join(chan, "replies", "dec1.json");
ok("answerAsk writes a reply the child can read", existsSync(replyPath));
const reply = JSON.parse(readFileSync(replyPath, "utf8"));
ok("reply shape matches the native channel", reply.type === "subagent.supervisor.reply" && reply.requestId === "dec1" && /DECISION NEEDED/.test(reply.message));
ok("answered ask disappears from the pending list", !P.findPendingAsks(runId).some((a) => a.requestId === "dec1"));

// --- detach marker --------------------------------------------------------
ok("detach receipt is recognised", P.INTERCOM_DETACH_MARK.test("Detached for intercom coordination before task completion."));
ok("an unrelated summary is not", !P.INTERCOM_DETACH_MARK.test("Implemented phases 1-4; suite green."));

// --- tests-section extraction --------------------------------------------
ok("numbered heading found", (P.extractTestsSection("# t\n\n## 6. Tests — the branch matrix\n\n| row | x |\n| a | b |\n\n## 7. Rollout\n\nz") ?? "").startsWith("## 6. Tests"));
ok("section stops at the next same-level heading", !(P.extractTestsSection("## Tests\n| a |\n## Rollout\nz") ?? "").includes("Rollout"));
ok("deeper heading does not end the section", (P.extractTestsSection("## Tests\n### T1\n| a |\n## Next") ?? "").includes("### T1"));
ok("no tests section -> null", P.extractTestsSection("## Design\n## Rollout") === null);
ok("'Test plan' is not a matrix heading", P.extractTestsSection("## Test plan\n- a\n- b") === null);

// --- the gate -------------------------------------------------------------
const exec = async (_c: string, args: string[]) => ({ code: 1, stdout: "", stderr: "no HEAD" });
const gateFor = async (text: string | null) => {
  const dir = mkdtempSync(join(tmpdir(), "fr-batch-gate-"));
  mkdirSync(dir, { recursive: true });
  if (text !== null) writeFileSync(join(dir, "P.md"), text);
  return P.planTestGate({ exec } as any, dir, { id: "probe", plan: "P.md" } as any);
};
ok("gate blocks a missing PLAN", !(await gateFor(null)).ok);
ok("gate blocks a PLAN with no tests section", !(await gateFor("# FR\n## Design\nstuff")).ok);
ok("gate blocks a tests section with no rows", !(await gateFor("## Tests\n\nTBD.\n")).ok);
ok("gate passes a real matrix", (await gateFor("## 6. Tests\n\n| id | what | proves non-vacuous |\n|---|---|---|\n| T1 | a | edit x |\n| T2 | b | edit y |\n")).ok);
ok("gate passes a bulleted matrix", (await gateFor("## Tests\n- T1 ... RED edit: x\n- T2 ... RED edit: y\n")).ok);
const why = (await gateFor("# FR\n## Design\nstuff")) as { ok: false; why: string };
ok("block message names the PLAN and says nothing ran", why.why.includes("P.md") && /NOT started/.test(why.why));

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
