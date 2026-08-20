import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { SupervisorAsk } from "./types.ts";

export const RPC_REQUEST = "subagents:rpc:v1:request";
export const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const ASYNC_COMPLETE = "subagent:async-complete";

export function makeRpc(pi: ExtensionAPI) {
  const call = <T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> =>
    new Promise((resolvePromise, rejectPromise) => {
      const requestId = randomUUID();
      let settled = false;
      const off = pi.events.on(`${RPC_REPLY_PREFIX}${requestId}`, (raw: unknown) => {
        if (settled) return;
        settled = true;
        if (typeof off === "function") off();
        const reply = raw as { success?: boolean; data?: T; error?: { code: string; message: string } };
        if (reply?.success) resolvePromise(reply.data as T);
        else rejectPromise(new Error(`${method} failed [${reply?.error?.code ?? "unknown"}]: ${reply?.error?.message ?? "no reply body"}`));
      });
      const t = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (typeof off === "function") off();
        rejectPromise(new Error(`${method}: no RPC reply within ${timeoutMs}ms — is pi-subagents loaded?`));
      }, timeoutMs);
      t.unref?.();
      pi.events.emit(RPC_REQUEST, { version: 1, requestId, method, params, source: { extension: "fr-batch" } });
    });
  return { call };
}

/**
 * Turn a legacy direct-execution param bag into the workflowScript spawn shape
 * pi-subagents now requires.
 *
 * `normalizePublicSubagentExecution` (pi-subagents extension/public-execution.ts)
 * rejects a spawn outright if `agent`, `task` or `step` is present, and demands a
 * non-empty `workflowScript`. So the per-child fields move INSIDE
 * `runs.run('main', {...})` and must not remain at the top level. Everything else
 * (`cwd`, `model`, `skill`, retry knobs, ...) is a workflow-level control and is
 * passed through untouched.
 *
 * JSON.stringify builds the options object rather than string concatenation: an
 * FR task body carries quotes, newlines, backticks and ``` fences, any of which
 * would otherwise terminate the generated script early. `__`-prefixed keys are
 * fr-batch's own bookkeeping and never reach the RPC.
 */
export function buildWorkflowSpawn(params: Record<string, unknown>, timeoutMs: number): Record<string, unknown> {
  const clean = Object.fromEntries(Object.entries(params).filter(([k]) => !k.startsWith("__")));
  const { agent, task, context, output, outputMode, acceptance, worktree, model, ...rest } = clean as Record<string, unknown>;
  const child: Record<string, unknown> = { agent, task };
  if (context !== undefined) child.context = context;
  if (output !== undefined) child.output = output;
  if (outputMode !== undefined) child.outputMode = outputMode;
  if (acceptance !== undefined) child.acceptance = acceptance;
  if (worktree !== undefined) child.worktree = worktree;
  // The model rides on the CHILD, not the workflow. A workflow-level model is only a default
  // for children that do not carry one, and per-child fields win — so putting it here keeps
  // this the single place the model is decided. It carries the reasoning effort as its
  // `:<effort>` suffix; spawn has no separate `thinking` param (see childSpawnParams).
  if (model !== undefined) child.model = model;
  // THE TIMEOUT MUST RIDE ON THE CHILD, NOT ON THE WORKFLOW. A workflow-level
  // `timeoutMs` does NOT propagate down to the child it launches: measured twice,
  // once with a 4-hour workflow budget whose child was still killed at 30 min,
  // and once here where childTimeoutMs 10800000 produced "Subagent timed out
  // after 5400000ms" — the child had fallen back to its own default. Per-child
  // fields override workflow defaults, so it goes inside runs.run.
  child.maxRuntimeMs = timeoutMs;
  return { ...rest, workflowScript: `return runs.run('main', ${JSON.stringify(child)});`, timeoutMs };
}

/** Spawn one async child and resolve when it completes. */
export async function runChild(
  pi: ExtensionAPI,
  rpc: { call: <T>(m: string, p: unknown, t?: number) => Promise<T> },
  params: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onAsyncId?: (id: string) => void,
): Promise<ChildOutcome> {
  let asyncId: string | undefined;
  let resolveDone!: (v: ChildOutcome) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<ChildOutcome>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  // Subscribe BEFORE spawning: a fast child must not finish inside the RPC
  // round-trip and be missed.
  const off = pi.events.on(ASYNC_COMPLETE, (raw: unknown) => {
    const payload = raw as {
      runId?: string;
      id?: string;
      state?: string;
      error?: string;
      nestedChildren?: Array<Record<string, unknown>>;
      results?: Array<{
        status?: string;
        summary?: string;
        artifactPath?: string;
        artifactPaths?: string[];
        structuredOutput?: unknown;
        error?: string;
        exitCode?: number | null;
        timedOut?: boolean;
        interrupted?: boolean;
        stopped?: boolean;
        attemptedModels?: string[];
        modelAttempts?: Array<{ model?: string; success?: boolean; error?: string }>;
        results?: Array<Record<string, unknown>>;
      }>;
    };
    if (!asyncId) return;
    if (payload?.runId !== asyncId && payload?.id !== asyncId) return;

    // A FAILED WORKFLOW CARRIES NO CHILD RESULTS. When the workflow itself dies
    // (`state: "failed"`, `error: "Run 'main' failed: aborted"`), `results` is an
    // EMPTY array — so reading results[0] alone never produces an outcome, this
    // promise never settles, and the item burns the full wallclock instead of
    // failing in seconds. Measured: a child aborted 8.7 minutes in and the driver
    // sat for the remaining 81 minutes.
    //
    // Worse, the transient-failure layer below is downstream of this resolve, so a
    // model-API outage — exactly what that layer exists to survive, and which the
    // child provably CANNOT self-report — never got classified and never triggered
    // the resume that would have preserved the files the child had already
    // written. Synthesising an outcome here is what arms that machinery.
    if (!payload.results?.[0]) {
      const failure =
        payload.error ??
        (payload.state && payload.state !== "complete" ? `workflow ${payload.state}` : undefined);
      resolveDone({
        asyncId,
        status: payload.state ?? "failed",
        summary: "",
        error: failure ?? "workflow completed with no child results",
      });
      return;
    }

    // Launches go through workflowScript (see below), so the OUTER results entry
    // describes the workflow wrapper and the child that actually did the work is
    // nested one level down. Prefer the nested entry and fall back to the outer
    // one, so this reads both the workflow shape and any plain single-child
    // shape without caring which it got.
    const outer = payload.results?.[0] ?? {};
    const nested = (Array.isArray(outer.results) && outer.results.length
      ? outer.results[0]
      : payload.nestedChildren?.[0]) as Record<string, unknown> | undefined;
    const pick = <T,>(key: string): T | undefined =>
      ((nested?.[key] as T | undefined) ?? ((outer as Record<string, unknown>)[key] as T | undefined));
    // The artifact belongs to the CHILD; the wrapper may carry only a plural form.
    const artifact =
      pick<string>("artifactPath") ??
      (nested?.artifactPaths as string[] | undefined)?.[0] ??
      outer.artifactPaths?.[0];

    resolveDone({
      asyncId,
      status: pick<string>("status") ?? "unknown",
      summary: pick<string>("summary") ?? "",
      artifactPath: artifact,
      // The child's schema-validated object, not its prose file. See ChildOutcome.
      structuredOutput: pick<unknown>("structuredOutput"),
      error: pick<string>("error"),
      exitCode: pick<number | null>("exitCode") ?? undefined,
      timedOut: pick<boolean>("timedOut"),
      interrupted: pick<boolean>("interrupted"),
      stopped: pick<boolean>("stopped"),
      attemptedModels: pick<string[]>("attemptedModels"),
      modelAttempts: pick<Array<{ model?: string; success?: boolean; error?: string }>>("modelAttempts"),
    });
  });

  const timer = setTimeout(() => rejectDone(new Error(`WALLCLOCK: child exceeded ${timeoutMs}ms`)), timeoutMs + 60_000);
  const onAbort = () => rejectDone(new Error("aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    // Two launch shapes, one completion wait: `resume` revives the exact child
    // from its persisted session (its context and the files it already wrote are
    // intact), which is what makes an outage recoverable without redoing work.
    //
    // The fresh-launch shape MUST be a workflowScript. pi-subagents'
    // normalizePublicSubagentExecution (extension/public-execution.ts:64) rejects
    // any spawn carrying `agent`, `task` or `step` with "Direct execution was
    // removed", so those fields cannot appear at the top level at all — they move
    // inside `runs.run`. JSON.stringify does the quoting, which matters because a
    // task body routinely contains quotes, newlines and backticks (markdown and
    // shell fences) that would otherwise break the generated script.
    const reply = params.__resumeOf
      ? await rpc.call<{ text: string; details?: { asyncId?: string; runId?: string } }>("resume", {
          id: params.__resumeOf as string,
          message: (params.__resumeMessage as string) ?? "Continue where you left off.",
        })
      : await rpc.call<{ text: string; details?: { asyncId?: string; runId?: string } }>("spawn", buildWorkflowSpawn(params, timeoutMs));
    asyncId = reply.details?.asyncId ?? reply.details?.runId;
    if (!asyncId) throw new Error(`launch returned no asyncId: ${(reply.text ?? "").slice(0, 200)}`);
    onAsyncId?.(asyncId);
    return await done;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (typeof off === "function") off();
  }
}

// ---------------------------------------------------------------------------
// transient-failure layer
//
// A model-API outage CANNOT be reported by the child: the child is a
// `pi --mode json -p` subprocess (subagent-runner.ts modelAttemptsLoop) and when
// the model call fails the failure is in the harness, so the model never gets a
// turn in which it could call contact_supervisor. Detection is therefore
// post-mortem, from the child's own failure evidence.
//
// A TOOL-level outage (the child's own bash/curl) is different: the child is
// alive and can report it. That path is handled by watchSupervisorAsks().
//
// Layering, deliberately: pi's in-child retry (settings retry.maxRetries 3,
// baseDelayMs 2000 -> ~14s) is the BLIP filter and is left alone. This layer is
// the OUTAGE handler and works in minutes. fallbackModels stays empty on the
// fr-* agents, or an outage is disguised as "several models failed for real".
//
// Roles can now sit on DIFFERENT providers (see resolveChildConfig), which the
// empty-fallback rule predates: a fallback across providers is not the same
// outage twice. It is still unconfigured, and two mechanical facts bound whoever
// revisits that, both established by reading pi-subagents rather than guessing:
//   * a fallback list is STATIC, agent-scoped config. buildModelCandidates reads
//     `agent.fallbackModels`; no spawn/RPC/workflow-child param carries one, so
//     "fall back to whatever the supervising session runs" cannot be expressed
//     there at all — only here, where the session snapshot lives.
//   * pi's in-child fallback re-invokes with the SAME `--session <file>`, so the
//     second model continues the transcript. A fallback implemented HERE cannot:
//     RPC `resume` takes { id, message } and reads the model from the persisted
//     descriptor, so switching models means a FRESH child over a half-edited
//     tree — losing exactly the work-preservation this layer exists for.
// ---------------------------------------------------------------------------

export interface ChildOutcome {
  asyncId: string;
  status: string;
  summary: string;
  artifactPath?: string;
  /**
   * The child's schema-validated output, delivered on the completion event.
   *
   * THIS IS THE AUTHORITATIVE VERDICT for an agent with an outputSchema, and it
   * is NOT the same thing as the output FILE. A child routinely writes its
   * narration to the file ("I've completed the audit. Let me do a final
   * verification...") while the structured object arrives here. Parsing the file
   * and ignoring this is what produced every AUDIT-UNPARSEABLE in this driver's
   * history — and it did not merely stall the run, it DISCARDED real findings:
   * one audit round delivered a specific `composition` gap here and the driver
   * replaced it with "the auditor did not return a schema-valid verdict".
   */
  structuredOutput?: unknown;
  error?: string;
  exitCode?: number;
  timedOut?: boolean;
  interrupted?: boolean;
  stopped?: boolean;
  attemptedModels?: string[];
  modelAttempts?: Array<{ model?: string; success?: boolean; error?: string }>;
  /**
   * Non-network `contact_supervisor` asks this child raised. Non-empty means the child hit a
   * question only the supervising session can answer, so the item pauses for a DECISION even
   * when the child otherwise ended "complete" (it was told to stop and write the question down).
   */
  decisionAsks?: SupervisorAsk[];
}
