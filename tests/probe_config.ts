// Guard probes for PER-CHILD MODEL / REASONING EFFORT.
//
// Two halves, and both are needed:
//   * the layer stack in isolation (precedence, per-field independence, the `:effort`
//     suffix, the load-time rejections);
//   * the same stack END TO END through runBatch's fake RPC bus — the resolution being
//     right is worthless if the resolved value never reaches the spawn params, which is
//     exactly the failure a unit-only probe cannot see.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBatch } from "../driver.ts";
import { addItem } from "../queue_ops.ts";
import { loadQueue } from "../store.ts";
import { renderStatus } from "../render.ts";
import { childSpawnParams, effortUndeliverable, itemModelLabel, normalizeChildConfig, resolveChildConfig, sessionChildConfig } from "../config.ts";



const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY = "subagents:rpc:v1:reply:";
const ASYNC_COMPLETE = "subagent:async-complete";

let fails = 0;
const ok = (n: string, c: boolean, extra = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${extra ? ` — ${extra}` : ""}`);
  if (!c) fails++;
};

const SESSION = { model: "amazon-bedrock/opus-5", thinking: "medium" as const };
const baseQueue = (extra: Record<string, unknown> = {}, items: any[] = []) => ({
  armed: true,
  maxFixRounds: 3,
  childTimeoutMs: 60_000,
  verifyTimeoutMs: 5_000,
  defaultVerify: ["true"],
  transient: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, probeUrl: "" },
  items,
  ...extra,
});

// ---------------------------------------------------------------------------
// 1. the layer stack: item.roles → item → queue.roles → queue.default* → session
// ---------------------------------------------------------------------------
{
  const q: any = baseQueue({
    defaultModel: "vendor/base",
    defaultThinking: "low",
    roles: { auditor: { model: "vendor/auditor" } },
  });
  const item: any = { id: "i", plan: "p", model: "vendor/item", thinking: "high", roles: { fixer: { thinking: "minimal" } } };

  ok(
    "item beats queue.roles and queue defaults",
    JSON.stringify(resolveChildConfig(q, item, "auditor", SESSION)) === JSON.stringify({ model: "vendor/item", thinking: "high" }),
    JSON.stringify(resolveChildConfig(q, item, "auditor", SESSION)),
  );
  ok(
    "item.roles is the most specific layer",
    resolveChildConfig(q, item, "fixer", SESSION).thinking === "minimal",
    JSON.stringify(resolveChildConfig(q, item, "fixer", SESSION)),
  );
  ok(
    "...and only for the field it sets — the model still comes from the item",
    resolveChildConfig(q, item, "fixer", SESSION).model === "vendor/item",
  );

  const bare: any = { id: "b", plan: "p" };
  ok(
    "queue.roles beats queue defaults for an item that configures nothing",
    JSON.stringify(resolveChildConfig(q, bare, "auditor", SESSION)) === JSON.stringify({ model: "vendor/auditor", thinking: "low" }),
    JSON.stringify(resolveChildConfig(q, bare, "auditor", SESSION)),
  );
  ok(
    "...and a role with no override lands on queue defaults",
    JSON.stringify(resolveChildConfig(q, bare, "implementer", SESSION)) === JSON.stringify({ model: "vendor/base", thinking: "low" }),
  );

  // The whole point of per-FIELD resolution: a role-level effort on top of a batch-wide model.
  const q2: any = baseQueue({ defaultModel: "vendor/base", roles: { auditor: { thinking: "high" } } });
  ok(
    "a role-level thinking composes with a queue-level model",
    JSON.stringify(resolveChildConfig(q2, bare, "auditor", {})) === JSON.stringify({ model: "vendor/base", thinking: "high" }),
    JSON.stringify(resolveChildConfig(q2, bare, "auditor", {})),
  );

  // Nothing configured anywhere: the session is the last layer, and it carries BOTH fields.
  const q3: any = baseQueue();
  ok(
    "an unconfigured queue inherits the session's model AND effort",
    JSON.stringify(resolveChildConfig(q3, bare, "implementer", SESSION)) === JSON.stringify(SESSION),
    JSON.stringify(resolveChildConfig(q3, bare, "implementer", SESSION)),
  );
  ok("...and resolves to nothing when the session is unknown", JSON.stringify(resolveChildConfig(q3, bare, "implementer", {})) === "{}");
}

// ---------------------------------------------------------------------------
// 2. an `:effort` suffix on a model string is a thinking value, not an opaque id
// ---------------------------------------------------------------------------
{
  ok(
    "a model suffix is lifted into thinking",
    JSON.stringify(normalizeChildConfig({ model: "vendor/base:high" })) === JSON.stringify({ model: "vendor/base", thinking: "high" }),
    JSON.stringify(normalizeChildConfig({ model: "vendor/base:high" })),
  );
  ok(
    "an unknown suffix is left alone (it is part of the id)",
    JSON.stringify(normalizeChildConfig({ model: "vendor/base:2024" })) === JSON.stringify({ model: "vendor/base:2024" }),
  );
  ok("an explicit thinking wins over the suffix at the same layer", normalizeChildConfig({ model: "v/b:low", thinking: "high" }).thinking === "high");

  // "inherit" is pi's parent-model sentinel: it must set no model here, so the next layer
  // supplies one and the effort still lands. Forwarding it would build `inherit:high`, an id
  // no registry resolves.
  const inheritOnly: any = baseQueue({ defaultModel: "inherit", defaultThinking: "xhigh" });
  ok(
    'model "inherit" raises the effort on the session model instead of becoming an id',
    JSON.stringify(resolveChildConfig(inheritOnly, { id: "i", plan: "p" } as any, "fixer", SESSION)) === JSON.stringify({ model: SESSION.model, thinking: "xhigh" }),
    JSON.stringify(resolveChildConfig(inheritOnly, { id: "i", plan: "p" } as any, "fixer", SESSION)),
  );

  // Lifting is what makes the suffix overridable: a more specific layer must be able to
  // replace it, which an opaque "v/b:low" string would not allow.
  const q: any = baseQueue({ defaultModel: "vendor/base:low", roles: { fixer: { thinking: "xhigh" } } });
  ok(
    "a role-level effort overrides an effort written as a suffix",
    JSON.stringify(resolveChildConfig(q, { id: "i", plan: "p" } as any, "fixer", {})) === JSON.stringify({ model: "vendor/base", thinking: "xhigh" }),
    JSON.stringify(resolveChildConfig(q, { id: "i", plan: "p" } as any, "fixer", {})),
  );
}

// ---------------------------------------------------------------------------
// 3. the spawn encoding — one string, because spawn has no `thinking` param
// ---------------------------------------------------------------------------
{
  ok("model + effort become one suffixed id", childSpawnParams({ model: "v/b", thinking: "high" }).model === "v/b:high");
  ok("a model without an effort is passed as is", childSpawnParams({ model: "v/b" }).model === "v/b");
  ok("no suffix is doubled", childSpawnParams(normalizeChildConfig({ model: "v/b:high" })).model === "v/b:high");
  ok("nothing resolved sends no model at all", JSON.stringify(childSpawnParams({})) === "{}");
  ok("an effort with no model is undeliverable and says so", effortUndeliverable({ thinking: "high" }) === true);
  ok("...and is reported in the label rather than dropped", /NOT applied/.test(itemModelLabel(baseQueue({ defaultThinking: "high" }) as any, { id: "i", plan: "p" } as any, {})));
  ok("an effort with a model is deliverable", effortUndeliverable({ model: "v/b", thinking: "high" }) === false);
}

// ---------------------------------------------------------------------------
// 4. sessionChildConfig: ctx first, PI_* env as the fallback
// ---------------------------------------------------------------------------
{
  const fromCtx = sessionChildConfig({ model: { provider: "p", id: "m" }, thinkingLevel: "xhigh" } as any);
  ok("ctx.model + ctx.thinkingLevel are the session layer", JSON.stringify(fromCtx) === JSON.stringify({ model: "p/m", thinking: "xhigh" }), JSON.stringify(fromCtx));

  const prev = { p: process.env.PI_PROVIDER, m: process.env.PI_MODEL, r: process.env.PI_REASONING_LEVEL };
  process.env.PI_PROVIDER = "envp";
  process.env.PI_MODEL = "envm";
  process.env.PI_REASONING_LEVEL = "low";
  ok("env is the fallback when ctx exposes no model", JSON.stringify(sessionChildConfig({} as any)) === JSON.stringify({ model: "envp/envm", thinking: "low" }));
  delete process.env.PI_PROVIDER;
  delete process.env.PI_MODEL;
  delete process.env.PI_REASONING_LEVEL;
  ok("neither available resolves to nothing", JSON.stringify(sessionChildConfig({} as any)) === "{}");
  // Only observable with the env cleared: an unrecognised ctx effort has nothing to fall
  // back to, so this is where "a level pi never emits is dropped" can be seen at all.
  ok("a bogus ctx thinking level is ignored, not forwarded", sessionChildConfig({ model: { provider: "p", id: "m" }, thinkingLevel: "higher" } as any).thinking === undefined);
  process.env.PI_PROVIDER = prev.p ?? "";
  process.env.PI_MODEL = prev.m ?? "";
  process.env.PI_REASONING_LEVEL = prev.r ?? "";
  if (!prev.p) delete process.env.PI_PROVIDER;
  if (!prev.m) delete process.env.PI_MODEL;
  if (!prev.r) delete process.env.PI_REASONING_LEVEL;
}

// ---------------------------------------------------------------------------
// 5. load-time rejection — a typo must not read as "configured"
// ---------------------------------------------------------------------------
function repoWithQueue(q: unknown): string {
  const repo = mkdtempSync(join(tmpdir(), "fr-batch-config-"));
  const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: repo, encoding: "utf8" });
  mkdirSync(join(repo, "docs"), { recursive: true });
  mkdirSync(join(repo, ".pi/fr-batch"), { recursive: true });
  writeFileSync(join(repo, "docs/FR_x_PLAN.md"), "# FR x\n\n## 5. Tests — the branch matrix\n\n| id | what | proves non-vacuous |\n|---|---|---|\n| T1 | a | edit a |\n");
  writeFileSync(join(repo, ".gitignore"), "/.pi/\n/.pi-subagents/\n"); // both trees are the driver's own; runBatch refuses if either is committable
  sh("git", ["init", "-q"]);
  sh("git", ["config", "user.email", "t@t"]);
  sh("git", ["config", "user.name", "t"]);
  sh("git", ["add", "-A"]);
  sh("git", ["commit", "-qm", "init"]);
  writeFileSync(join(repo, ".pi/fr-batch/queue.json"), JSON.stringify(q, null, 2));
  return repo;
}

const loadErr = (q: unknown): string => {
  try {
    loadQueue(repoWithQueue(q));
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};

ok("a bad queue-level effort is rejected at load", /thinking "higher" is not a reasoning effort/.test(loadErr(baseQueue({ defaultThinking: "higher" }))), loadErr(baseQueue({ defaultThinking: "higher" })));
ok("...and names the accepted values", /off, minimal, low, medium, high, xhigh, max/.test(loadErr(baseQueue({ defaultThinking: "higher" }))));
ok("a bad item-level effort is rejected", /item "i".*thinking "hi"/.test(loadErr(baseQueue({}, [{ id: "i", plan: "p", thinking: "hi" }]))), loadErr(baseQueue({}, [{ id: "i", plan: "p", thinking: "hi" }])));
ok("an unknown role is rejected", /names role "reviewer"/.test(loadErr(baseQueue({ roles: { reviewer: { model: "v/b" } } }))), loadErr(baseQueue({ roles: { reviewer: { model: "v/b" } } })));
ok("an unknown field inside a role block is rejected", /unknown field\(s\) effort/.test(loadErr(baseQueue({ roles: { fixer: { effort: "high" } } }))), loadErr(baseQueue({ roles: { fixer: { effort: "high" } } })));
ok("an empty model is rejected", /model must be a non-empty string/.test(loadErr(baseQueue({ defaultModel: "  " }))));
ok("a queue with no model config at all still loads", loadErr(baseQueue()) === "");

// ---------------------------------------------------------------------------
// 6. `add` writes the config, refuses a bad effort, and says what is inherited
// ---------------------------------------------------------------------------
{
  const repo = repoWithQueue(baseQueue());
  const bad = addItem(repo, { plan: "docs/FR_x_PLAN.md", id: "b", thinking: "higher" });
  ok("add refuses a bad effort", /refused/.test(bad) && /not a reasoning effort/.test(bad), bad);
  ok("...and did not queue it", loadQueue(repo).items.length === 0);

  const good = addItem(repo, { plan: "docs/FR_x_PLAN.md", id: "g", model: "vendor/base:high" });
  ok("add stores a suffixed model as model + thinking", JSON.stringify(loadQueue(repo).items[0]).includes('"model":"vendor/base"') && JSON.stringify(loadQueue(repo).items[0]).includes('"thinking":"high"'), JSON.stringify(loadQueue(repo).items[0]));
  ok("...and reports what it set", /model: base:high/.test(good), good);

  const inherited = addItem(repo, { plan: "docs/FR_x_PLAN.md", id: "h" });
  ok("an add with no model says the item inherits", /inherits queue.roles/.test(inherited), inherited);

  // status: quiet for a baseline item, chipped for an overriding one.
  const st = renderStatus(repo, SESSION);
  ok("status states the resolved model and what inherit means", /model: opus-5:medium · session inherit: opus-5:medium/.test(st), st.split("\n")[1]);
  ok("...chips only the item that differs from the baseline", /g\s+pending\s+.*model:base:high/.test(st) && !/h\s+pending\s+.*model:/.test(st), st);
}

// ---------------------------------------------------------------------------
// 7. END TO END: the resolved value reaches the spawn params of every role
// ---------------------------------------------------------------------------
interface Spawned {
  agent: string;
  model?: string;
}

function makeFake(repo: string) {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  const spawns: Spawned[] = [];
  let n = 0;
  const fire = (name: string, payload: unknown) => {
    for (const h of [...(handlers.get(name) ?? [])]) h(payload);
  };
  const pi: any = {
    exec: async (cmd: string, args: string[], o: any) => {
      try {
        return { code: 0, stdout: execFileSync(cmd, args, { cwd: o?.cwd ?? repo, encoding: "utf8" }), stderr: "" };
      } catch (e: any) {
        return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e) };
      }
    },
    events: {
      on: (name: string, h: (d: unknown) => void) => {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(h);
        return () => handlers.get(name)!.delete(h);
      },
      emit: (name: string, payload: unknown) => {
        if (name !== RPC_REQUEST) return void fire(name, payload);
        const req = payload as { requestId: string; method: string; params: any };
        const asyncId = `run-${++n}`;
        const script = String(req.params?.workflowScript ?? "");
        const child = JSON.parse(script.slice(script.indexOf("{"), script.lastIndexOf("}") + 1));
        spawns.push({ agent: child.agent, model: child.model });
        fire(`${RPC_REPLY}${req.requestId}`, { version: 1, requestId: req.requestId, success: true, data: { text: "launched", details: { asyncId } } });
        setTimeout(() => {
          // The implementer must leave the tree dirty or the driver treats it as a no-op.
          writeFileSync(join(repo, "impl.txt"), `work ${n}\n`);
          fire(ASYNC_COMPLETE, {
            runId: asyncId,
            state: "completed",
            results: [
              {
                status: "complete",
                summary: "done",
                ...(child.agent === "fr-test-auditor" ? { structuredOutput: { verdict: "complete", gaps: [] } } : {}),
              },
            ],
          });
        }, 5);
      },
    },
    appendEntry: () => {},
    sendMessage: () => {},
  };
  return { pi, spawns };
}

{
  const repo = repoWithQueue(
    baseQueue(
      { defaultModel: "vendor/base", defaultThinking: "low", roles: { auditor: { thinking: "high" } } },
      [{ id: "x", plan: "docs/FR_x_PLAN.md", roles: { implementer: { model: "vendor/strong" } } }],
    ),
  );
  const { pi, spawns } = makeFake(repo);
  const ctx: any = { cwd: repo, hasUI: false, ui: {}, model: { provider: "sess", id: "sessmodel" }, thinkingLevel: "minimal" };
  const out = await runBatch(pi, ctx, { background: true }, () => {});

  ok("the happy path committed", /finished/.test(out), out.split("\n")[0]);
  const impl = spawns.find((s) => s.agent === "fr-implementer");
  const audit = spawns.find((s) => s.agent === "fr-test-auditor");
  ok("the implementer got its item-role model with the queue effort", impl?.model === "vendor/strong:low", JSON.stringify(impl));
  ok("the auditor got the queue model with its role effort", audit?.model === "vendor/base:high", JSON.stringify(audit));
  ok("no child was spawned without a model", spawns.every((s) => typeof s.model === "string"), JSON.stringify(spawns));
}

// The fixer path, and the session-inherit path, in one red-verify run.
{
  const repo = repoWithQueue(baseQueue({ defaultVerify: ["false"], maxFixRounds: 1 }, [{ id: "x", plan: "docs/FR_x_PLAN.md" }]));
  const { pi, spawns } = makeFake(repo);
  const ctx: any = { cwd: repo, hasUI: false, ui: {}, model: { provider: "sess", id: "sessmodel" }, thinkingLevel: "minimal" };
  const out = await runBatch(pi, ctx, { background: true }, () => {});

  ok("a red verify blocks after its fix round", /Verify failed after 1 fix round/.test(out), out.split("\n")[0]);
  const fixer = spawns.find((s) => s.agent === "fr-gap-fixer");
  ok("the fixer inherits the SESSION model and effort when nothing is configured", fixer?.model === "sess/sessmodel:minimal", JSON.stringify(spawns));
  ok("...and so does the implementer", spawns[0]?.model === "sess/sessmodel:minimal", JSON.stringify(spawns[0]));
}

// ---------------------------------------------------------------------------
// QUOTA RETRY — a 429 gets its OWN budget, counted apart from network faults
//
// Why this probe exists: a `429 insufficient_quota` was classified transient (correct) and then
// spent the SHARED 6-attempt / 300s-cap budget in ~13 minutes, after which the batch PAUSED and
// waited for a human to type "continue" — for a condition that fixes itself when the provider's
// window rolls over. The verdict was right and the BUDGET was wrong.
// ---------------------------------------------------------------------------
{
  const { isQuotaReason, backoffDelay } = await import("../resilience.ts");
  const { transientPolicy, transientQuotaPolicy } = await import("../store.ts");

  // The classifier reads the reason string transientHit already returned — one signature list.
  for (const yes of ["429", "insufficient_quota", "rate limit", "Too Many Requests", "quota"])
    ok(`isQuotaReason should accept ${JSON.stringify(yes)}`, isQuotaReason(yes));
  // A transport fault must NOT be reclassified: it would then wait 30 min for a 2s blip.
  for (const no of ["502", "503", "aborted", "connection reset", "stream interrupted", null])
    ok(`isQuotaReason should reject ${JSON.stringify(no)}`, !isQuotaReason(no as string));

  const q = { armed: true, items: [] } as unknown as Parameters<typeof transientPolicy>[0];
  const net = transientPolicy(q);
  const quo = transientQuotaPolicy(q);

  // The point of the split: the quota horizon must be ORDERS longer, not marginally longer.
  ok("quota budget should allow far more attempts", quo.maxRetries > net.maxRetries * 5);
  ok("quota backoff should cap far higher", quo.maxDelayMs >= net.maxDelayMs * 5);
  // ~27h of horizon: the cap is reached early and every later wait is the cap.
  const horizon = Array.from({ length: quo.maxRetries }, (_, i) =>
    Math.min(quo.maxDelayMs, quo.baseDelayMs * 2 ** i),
  ).reduce((a, b) => a + b, 0);
  ok(`quota horizon should exceed 20h, got ${Math.round(horizon / 3600000)}h`, horizon > 20 * 3600 * 1000);

  // A repo tightening `transient` for fast network failure must NOT tighten the quota budget —
  // that coupling is exactly what this split removes, so it is asserted rather than assumed.
  const tightened = { armed: true, items: [], transient: { maxRetries: 0, maxDelayMs: 1 } } as unknown as Parameters<typeof transientPolicy>[0];
  ok("transient override should apply", transientPolicy(tightened).maxRetries === 0);
  ok(
    "a transient override must NOT leak into the quota policy",
    transientQuotaPolicy(tightened).maxRetries === quo.maxRetries,
  );
  // And an explicit quota override still wins.
  const qover = { armed: true, items: [], transientQuota: { maxRetries: 3 } } as unknown as Parameters<typeof transientPolicy>[0];
  ok("transientQuota override should apply", transientQuotaPolicy(qover).maxRetries === 3);

  // backoffDelay is jittered around the target, so bound it rather than equate it.
  const d = backoffDelay(0, quo);
  ok(`jittered base delay out of range: ${d}`, d >= quo.baseDelayMs * 0.5 && d <= quo.baseDelayMs * 1.5);
  const dcap = backoffDelay(40, quo);
  ok(`capped delay should respect maxDelayMs, got ${dcap}`, dcap <= quo.maxDelayMs * 1.5);
}



console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);

process.exit(fails === 0 ? 0 : 1);