import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertChildConfig, assertRoleConfigs } from "./config.ts";
import { baseDir, historyPath, progressPath, queuePath, runlockPath, writeAtomic } from "./paths.ts";
import { TRANSIENT_DEFAULTS } from "./types.ts";
import type { HistoryEntry, ItemStatus, Log, Progress, ProgressEntry, Queue, QueueItem, TransientPolicy } from "./types.ts";

export const STALE_RUNLOCK_MS = 15 * 60 * 1000;

/** How often the live driver refreshes its run lock's mtime, so a long run never looks stale. */
export const RUNLOCK_TOUCH_MS = 60 * 1000;

export function loadQueue(cwd: string): Queue {
  const p = queuePath(cwd);
  if (!existsSync(p)) throw new Error(`fr-batch: queue not found at ${p}`);
  const q = JSON.parse(readFileSync(p, "utf8")) as Queue;
  if (!Array.isArray(q.items)) throw new Error("fr-batch: queue.items must be an array");
  if (!Array.isArray(q.defaultVerify) || q.defaultVerify.length === 0) {
    throw new Error("fr-batch: queue.defaultVerify must be a non-empty array — an empty verify gate is no gate");
  }
  const seen = new Set<string>();
  assertChildConfig("queue", { model: q.defaultModel, thinking: q.defaultThinking });
  assertRoleConfigs("queue.roles", q.roles);
  for (const item of q.items) {
    if (!item.id || !item.plan) throw new Error(`fr-batch: every queue item needs id and plan (offender: ${JSON.stringify(item).slice(0, 120)})`);
    if (seen.has(item.id)) throw new Error(`fr-batch: duplicate queue item id "${item.id}"`);
    seen.add(item.id);
    assertChildConfig(`item "${item.id}"`, { model: item.model, thinking: item.thinking });
    assertRoleConfigs(`item "${item.id}".roles`, item.roles);
  }
  return q;
}

/** Merge the queue's transient block over the defaults so an older queue.json still loads. */
export function transientPolicy(q: Queue): TransientPolicy {
  return { ...TRANSIENT_DEFAULTS, ...(q.transient ?? {}) };
}

// ---------------------------------------------------------------------------
// per-child model / reasoning effort
//
// Four layers, most specific first, EACH FIELD RESOLVED ON ITS OWN:
//
//   item.roles[role]  ->  item  ->  queue.roles[role]  ->  queue.default*  ->  session
//
// Per-field rather than per-object so `roles: { auditor: { thinking: "high" } }` can sit
// on top of a `defaultModel` without having to restate the model.
//
// The last layer is the supervising conversation itself, which is what "configure nothing
// and it inherits the current session" means. That layer has to be passed EXPLICITLY:
// pi-subagents inherits the parent MODEL on its own (resolveEffectiveSubagentModel) but
// NOT the parent's reasoning effort — with no `thinking` on the agent config the child
// falls back to the global default — so leaving it implicit inherits half the setting.
// ---------------------------------------------------------------------------

/** The driver's file. Written only here, always atomically, never merged with queue.json. */
export function loadProgress(cwd: string): Progress {
  const p = progressPath(cwd);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Progress;
  } catch {
    return {};
  }
}

export function setProgress(cwd: string, id: string, patch: Partial<ProgressEntry>): ProgressEntry {
  // Read-modify-write against the file, not against a snapshot: `run` is the only
  // writer, but a crash mid-batch must not lose earlier items' state.
  const all = loadProgress(cwd);
  const next: ProgressEntry = {
    status: patch.status ?? all[id]?.status ?? "pending",
    fixRounds: patch.fixRounds ?? all[id]?.fixRounds ?? 0,
    updatedAt: new Date().toISOString(),
    ...(patch.note !== undefined ? { note: patch.note } : all[id]?.note ? { note: all[id].note } : {}),
    ...(patch.sha !== undefined ? { sha: patch.sha } : all[id]?.sha ? { sha: all[id].sha } : {}),
    // Pause fields are meaningful only while paused: any other status clears them,
    // so a stale childId can never be revived into the wrong phase.
    ...(patch.status === "paused"
      ? {
          ...(patch.pausedPhase !== undefined ? { pausedPhase: patch.pausedPhase } : all[id]?.pausedPhase ? { pausedPhase: all[id].pausedPhase } : {}),
          ...(patch.pausedChildId !== undefined ? { pausedChildId: patch.pausedChildId } : all[id]?.pausedChildId ? { pausedChildId: all[id].pausedChildId } : {}),
          ...(patch.pausedRound !== undefined ? { pausedRound: patch.pausedRound } : {}),
          ...(patch.pauseKind !== undefined ? { pauseKind: patch.pauseKind } : all[id]?.pauseKind ? { pauseKind: all[id].pauseKind } : {}),
          ...(patch.pendingAsk !== undefined ? { pendingAsk: patch.pendingAsk } : all[id]?.pendingAsk ? { pendingAsk: all[id].pendingAsk } : {}),
        }
      : {}),
  };
  all[id] = next;
  writeAtomic(progressPath(cwd), `${JSON.stringify(all, null, 2)}\n`);
  return next;
}

export function statusOf(progress: Progress, id: string): ItemStatus {
  return progress[id]?.status ?? "pending";
}

// ---------------------------------------------------------------------------
// history (append-only)
//
// JSONL, not JSON, and appended rather than rewritten. Three reasons, all of which
// bite exactly when the record gets long:
//   * an append is O(1) in the size of the record, so archiving item 400 costs what
//     archiving item 1 did;
//   * a torn or hand-mangled line loses ONE item instead of failing the parse of the
//     whole file, so a bad byte can never brick the record (see loadHistory's skip);
//   * `grep '"id":"foo"'` answers the common question without loading anything.
// Nothing on the status path reads it — only countHistory, which needs a line count.
// ---------------------------------------------------------------------------

/** Malformed lines are SKIPPED, not thrown on: one bad line must not hide 400 good ones. */
export function loadHistory(cwd: string): HistoryEntry[] {
  const p = historyPath(cwd);
  if (!existsSync(p)) return [];
  const out: HistoryEntry[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as HistoryEntry;
      if (e && typeof e.id === "string") out.push(e);
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * How many items are archived, without materialising them. `status` shows this number and
 * nothing else from the record, so it must not cost a parse of every line.
 *
 * A line counts when it looks like one whole object. Cheaper than JSON.parse and it agrees
 * with loadHistory on the realistic corruption — a half-written last line, which cannot end
 * in `}` — so `status` never reports a count that `history` then fails to show.
 */
export function countHistory(cwd: string): number {
  const p = historyPath(cwd);
  if (!existsSync(p)) return 0;
  let n = 0;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (t.startsWith("{") && t.endsWith("}")) n++;
  }
  return n;
}

/** One `\n`-terminated line per entry, so a crash mid-write costs at most the last line. */
export function appendHistory(cwd: string, entries: HistoryEntry[]): void {
  if (entries.length === 0) return;
  mkdirSync(baseDir(cwd), { recursive: true });
  appendFileSync(historyPath(cwd), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// frozen audit contract + gap ledger
//
// This is what makes the audit loop terminate. The auditor is adversarial by
// design and will always find one more thing to want; the fixer is told to keep
// the live PLAN truthful and may add production branches while closing a gap. Judge
// round N+1 against the live PLAN and those two facts compose into a loop with no
// fixed point. So the contract is snapshotted once and every round is judged
// against the snapshot, out-of-contract findings are demoted to notes, and the
// ledger remembers what was already adjudicated.
// ---------------------------------------------------------------------------

export function verifyFor(q: Queue, item: QueueItem): { cmds: string[]; isDefault: boolean } {
  return item.verify && item.verify.length > 0
    ? { cmds: item.verify, isDefault: false }
    : { cmds: q.defaultVerify, isDefault: true };
}

export function artifactDir(cwd: string): string {
  const d = join(cwd, ".pi-subagents", "fr-batch");
  mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Drop the intermediate round artifacts of an item that COMMITTED, keeping the last
 * audit verdict and the implement report. Nothing is pruned for a blocked item — those
 * files are the scene of the failure and are exactly what a human needs.
 *
 * Every child spawn also leaves ~1-2MB of transcript in pi-subagents' own artifact root,
 * which this cannot reach; set `artifactDir: "session"` in pi-subagents' settings so that
 * root is age-cleaned instead of accumulating in the working tree forever.
 */
export function pruneItemArtifacts(cwd: string, id: string, log: Log): void {
  const d = artifactDir(cwd);
  let files: string[] = [];
  try {
    files = readdirSync(d).filter((f) => f.startsWith(`${id}-`));
  } catch {
    return;
  }
  const roundOf = (f: string): number => Number(f.match(/-audit-(\d+)\.json$/)?.[1] ?? -1);
  const lastVerdict = files.filter((f) => roundOf(f) >= 0).sort((a, b) => roundOf(a) - roundOf(b)).pop();
  const keep = new Set([lastVerdict, `${id}-implement.md`].filter(Boolean) as string[]);
  let freed = 0;
  for (const f of files) {
    if (keep.has(f)) continue;
    const p = join(d, f);
    try {
      freed += statSync(p).size;
      rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
  const dropped = files.length - keep.size;
  if (dropped > 0) log(`  pruned ${dropped} intermediate round artifact(s) (${Math.round(freed / 1024)}KB); kept ${[...keep].join(", ")}`);
}

// ---------------------------------------------------------------------------
// single-driver interlock
// ---------------------------------------------------------------------------

export function acquireRunlock(cwd: string): { release: () => void } | { held: string } {
  const p = runlockPath(cwd);
  if (existsSync(p)) {
    const age = Date.now() - statSync(p).mtimeMs;
    let holder = "unknown";
    try {
      holder = readFileSync(p, "utf8").trim();
    } catch {
      /* ignore */
    }
    if (age < STALE_RUNLOCK_MS) return { held: holder };
    rmSync(p, { force: true }); // stale
  }
  mkdirSync(dirname(p), { recursive: true });
  try {
    const fd = openSync(p, "wx");
    closeSync(fd);
    writeFileSync(p, `pid ${process.pid} since ${new Date().toISOString()}\n`, "utf8");
  } catch {
    return { held: "another process won the race" };
  }
  return { release: () => rmSync(p, { force: true }) };
}

/**
 * Keep a live driver's lock young. `acquireRunlock` treats a lock older than
 * STALE_RUNLOCK_MS as abandoned, which was safe only while a run could not outlive a
 * turn; a background batch routinely runs for hours, and without this a second session
 * would decide the first one had died and start writing the same tree.
 */
export function touchRunlock(cwd: string): void {
  const p = runlockPath(cwd);
  if (!existsSync(p)) return;
  const now = new Date();
  try {
    utimesSync(p, now, now);
  } catch {
    /* a lock we cannot touch is reported by the next acquire, not here */
  }
}

// ---------------------------------------------------------------------------
// pi-subagents RPC
// ---------------------------------------------------------------------------
