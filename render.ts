import { existsSync } from "node:fs";
import { join } from "node:path";
import { itemModelLabel, modelLabel } from "./config.ts";
import { loadLedger } from "./contract.ts";
import { contractPath, historyPath, itemStateFiles, outOfScopePath, progressPath, queuePath, runlockPath } from "./paths.ts";
import { describeLive, drivers, elapsedLabel, finishedRuns } from "./state.ts";
import { countHistory, loadHistory, loadProgress, loadQueue, statusOf, transientPolicy, verifyFor } from "./store.ts";
import type { ChildConfig, ItemStatus, Progress, Queue, QueueItem } from "./types.ts";

/** Default number of archived items `history` lists, newest first. */
export const HISTORY_ROWS = 20;

/**
 * The record, newest first. Bounded by `limit` because the whole point of archiving is that
 * the finished record never has to be paid for in full.
 */
export function renderHistory(cwd: string, only: string | undefined, limit: number): string {
  const all = loadHistory(cwd);
  if (all.length === 0) {
    return [
      `fr-batch: no history yet (${historyPath(cwd)} does not exist).`,
      'Committed items stay in the queue until you sweep them with fr_batch action "archive".',
    ].join("\n");
  }
  if (only) {
    const hits = all.filter((e) => e.id === only);
    if (hits.length === 0) return `fr-batch: no archived item with id "${only}" (${all.length} archived).`;
    return hits
      .map((e) =>
        [
          `${e.id}  ${e.sha ?? "(no sha)"}`,
          `  plan:       ${e.plan}`,
          ...(e.commitMsg ? [`  commit:     ${e.commitMsg}`] : []),
          `  fixRounds:  ${e.fixRounds}`,
          `  committed:  ${e.committedAt ?? "unknown"}   archived: ${e.archivedAt}`,
          ...(e.stateDir ? [`  evidence:   .pi/fr-batch/${e.stateDir}/`] : []),
          ...(e.note ? ["  note:", ...e.note.split("\n").map((l) => `    ${l}`)] : []),
        ].join("\n"),
      )
      .join("\n\n");
  }
  const shown = all.slice(-limit).reverse();
  return [
    `fr-batch history — ${all.length} archived item(s), newest ${shown.length} shown:`,
    ...shown.map((e) => `  ${(e.sha ?? "").slice(0, 9).padEnd(9)} ${e.id.padEnd(24)} fixes:${e.fixRounds} ${(e.archivedAt ?? "").slice(0, 10)}`),
    ...(all.length > shown.length ? [`  ⋯ ${all.length - shown.length} older item(s) — raise limit, or grep ${historyPath(cwd)}`] : []),
    "",
    'One item in full (incl. its closing note): fr_batch action "history", only: "<id>".',
  ].join("\n");
}


/**
 * How many upcoming `pending` rows the default status view shows. Everything IN FLIGHT is
 * always shown; the pending tail is a preview, and three of it is enough to see the order.
 */
export const STATUS_PENDING_WINDOW = 3;

/** Orphan ids listed inline before the list itself becomes the O(n) it is warning about. */
export const STATUS_ORPHAN_LIST = 8;

/**
 * How many committed items may sit in the queue before `status` says to sweep them. Not 1:
 * an item committed thirty seconds ago is still the thing the operator is looking at, and a
 * line telling them to file it away is noise on every render of a short batch.
 */
export const STATUS_ARCHIVE_NAG = 3;

/**
 * What `status` renders. The DEFAULT IS A SUMMARY, and that is a token budget decision, not
 * a cosmetic one: the old view was one line per queue item, so asking "how is it going" on a
 * 300-item queue cost ~300 lines every time, of which at most a handful were actionable.
 * `all` restores the full listing; `only` trades the listing for one item in depth.
 */
export interface StatusView {
  all?: boolean;
  only?: string;
}

/** The trailing chips on one status row — shared with the `only` detail view so they cannot drift. */
export function itemChips(q: Queue, item: QueueItem, progress: Progress, session: ChildConfig, baselineModel: string, cwd: string): string {
  const p = progress[item.id];
  const s = statusOf(progress, item.id);
  return [
    p?.sha ? p.sha : "",
    p?.fixRounds ? `fixes:${p.fixRounds}` : "",
    s === "paused" && p?.pausedPhase ? `at:${p.pausedPhase}` : "",
    s === "paused" ? `pause:${p?.pauseKind ?? "network"}` : "",
    verifyFor(q, item).isDefault ? "verify:default" : "",
    itemModelLabel(q, item, session) !== baselineModel ? `model:${itemModelLabel(q, item, session)}` : "",
    existsSync(contractPath(cwd, item.id)) ? "contract:frozen" : "",
    existsSync(outOfScopePath(cwd, item.id)) ? "out-of-scope:yes" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * One item in full. This is the answer to "why would I read queue.json by hand" — the row
 * chips are abbreviations, and a blocked item's note is the one field worth its whole length.
 */
export function renderItemDetail(cwd: string, id: string, session: ChildConfig): string {
  const q = loadQueue(cwd);
  const progress = loadProgress(cwd);
  const at = q.items.findIndex((i) => i.id === id);
  if (at < 0) {
    const hist = loadHistory(cwd).filter((e) => e.id === id);
    if (hist.length > 0) return `fr-batch: "${id}" is not in the live queue — it is archived.\n\n${renderHistory(cwd, id, 1)}`;
    return `fr-batch: no queued item with id "${id}" (${q.items.length} live item(s), ${countHistory(cwd)} archived).`;
  }
  const item = q.items[at];
  const p = progress[id];
  const v = verifyFor(q, item);
  const ledger = loadLedger(cwd, id);
  const gaps = Object.entries(ledger);
  const open = gaps.filter(([, g]) => g.state === "open");
  return [
    `fr-batch — item "${id}"  (${at + 1}/${q.items.length})`,
    `status:    ${statusOf(progress, id)}${p?.fixRounds ? `  fixRounds:${p.fixRounds}` : ""}${p?.sha ? `  sha:${p.sha}` : ""}`,
    `plan:      ${item.plan}`,
    ...(item.fr ? [`fr:        ${item.fr}`] : []),
    ...(item.reads?.length ? [`reads:     ${item.reads.join(", ")}`] : []),
    `verify:    ${v.isDefault ? "(queue.defaultVerify)" : ""}`,
    ...v.cmds.map((c) => `           ${c}`),
    `model:     ${itemModelLabel(q, item, session)}`,
    ...(gaps.length > 0 ? [`gaps:      ${gaps.length} adjudicated, ${open.length} open${open.length ? ` (${open.map(([k]) => k).join(", ")})` : ""}`] : []),
    `state:     ${itemStateFiles(cwd, id).filter((f) => existsSync(f)).length}/3 file(s) present in .pi/fr-batch/`,
    ...(p?.pendingAsk ? ["", "pending question (verbatim):", p.pendingAsk] : []),
    ...(p?.note ? ["", "note:", ...p.note.split("\n").map((l) => `  ${l}`)] : []),
  ].join("\n");
}

/**
 * `session` is the inherit layer, so the caller passes the live one. It defaults to empty for
 * a caller that has no ExtensionContext (the guard tests), where every row then reads
 * "inherit" — which is exactly what an unresolvable session means.
 */
export function renderStatus(cwd: string, session: ChildConfig = {}, view: StatusView = {}): string {
  if (view.only) return renderItemDetail(cwd, view.only, session);
  const q = loadQueue(cwd);
  const progress = loadProgress(cwd);
  const locked = existsSync(runlockPath(cwd));
  const live = drivers.get(cwd);
  const last = finishedRuns.get(cwd);
  // Rows only carry a model chip when they DIFFER from this, so the common case stays quiet.
  const baselineModel = itemModelLabel(q, { id: "", plan: "" }, session);

  // Which rows earn their tokens: everything not at rest, plus a short preview of what is next.
  // `committed` and the deep pending tail are the two O(n) classes, and neither is actionable.
  const previewPending = new Set(
    q.items
      .filter((i) => statusOf(progress, i.id) === "pending")
      .slice(0, STATUS_PENDING_WINDOW)
      .map((i) => i.id),
  );
  const isShown = (i: QueueItem): boolean => {
    if (view.all) return true;
    const s = statusOf(progress, i.id);
    if (s === "committed") return false;
    if (s === "pending") return previewPending.has(i.id);
    return true;
  };

  // Queue order is preserved and every hidden RUN is replaced by one line that says what it
  // held, so the view never silently omits work — it says how much it folded and of what kind.
  const rows: string[] = [];
  let hiddenTotal = 0;
  let run: ItemStatus[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const byStatus = [...new Set(run)].map((s) => `${run.filter((x) => x === s).length} ${s}`).join(", ");
    rows.push(`  ⋯ ${String(run.length).padStart(2)}  hidden — ${byStatus}`);
    hiddenTotal += run.length;
    run = [];
  };
  q.items.forEach((i, n) => {
    const s = statusOf(progress, i.id);
    if (!isShown(i)) {
      run.push(s);
      return;
    }
    flush();
    const mark = s === "committed" ? "✓" : s === "blocked" ? "✗" : s === "paused" ? "⏸" : s === "pending" ? " " : "…";
    const note = (s === "blocked" || s === "paused") && progress[i.id]?.note ? `\n         ${progress[i.id]!.note!.split("\n")[0]}` : "";
    rows.push(`  ${mark} ${String(n + 1).padStart(2)}. ${i.id.padEnd(24)} ${s.padEnd(13)} ${itemChips(q, i, progress, session, baselineModel, cwd)}${note}`);
  });
  flush();

  const done = q.items.filter((i) => statusOf(progress, i.id) === "committed").length;
  const paused = q.items.filter((i) => statusOf(progress, i.id) === "paused");
  const waiting = paused.filter((i) => progress[i.id]?.pauseKind === "decision");
  const stopped = paused.filter((i) => progress[i.id]?.pauseKind === "stopped");
  const outage = paused.filter((i) => (progress[i.id]?.pauseKind ?? "network") === "network");
  const orphans = Object.keys(progress).filter((id) => !q.items.some((i) => i.id === id));
  const archived = countHistory(cwd);
  const pol = transientPolicy(q);
  return [
    `fr-batch — armed: ${q.armed} · maxFixRounds: ${q.maxFixRounds} · ${done}/${q.items.length} committed${archived ? ` · ${archived} archived` : ""}`,
    `model: ${baselineModel}${session.model ? ` · session inherit: ${modelLabel(session)}` : " · session model unknown"}`,
    ...(live
      ? [`driver: ${describeLive(live)}`]
      : locked
        ? [`driver: none in this session, but a run lock is present (${runlockPath(cwd)}) — another session may own it`]
        : ["driver: idle"]),
    ...(!live && last ? [`last run: ended ${elapsedLabel(Date.now() - last.at)} ago after ${elapsedLabel(last.elapsedMs)} — ${last.text.split("\n")[0]}`] : []),
    ...rows,
    ...(hiddenTotal > 0
      ? [`  (summary view: in-flight + next ${STATUS_PENDING_WINDOW} pending. all:true = every row, only:"<id>" = one item in full.)`]
      : []),
    "",
    ...(done >= STATUS_ARCHIVE_NAG && !view.all && !live && !locked
      ? [
          `${done} committed item(s) still sit in the queue. Sweep them into history.jsonl with fr_batch action "archive" — the queue is re-read at every item boundary and rendered on every status, so keeping it at the size of the OPEN batch is what stops a long project from paying for its whole history on each look.`,
          "",
        ]
      : []),
    ...(waiting.length > 0
      ? waiting.flatMap((i) => [
          `⏸ ${i.id} is WAITING FOR A DECISION. Its child asked, verbatim:`,
          progress[i.id]?.pendingAsk ?? "  (question not recorded)",
          `Deliver it with: fr_batch action "continue", only: "${i.id}", answer: "<your decision>"`,
          "",
        ])
      : []),
    ...(outage.length > 0
      ? [`⏸ ${outage.length} item(s) paused on a network outage. When the connection is back: fr_batch action "continue".`, ""]
      : []),
    ...(stopped.length > 0
      ? [
          `⏸ ${stopped.length} item(s) paused by a hard stop. Their abandoned child may have left partial edits;`,
          `  fr_batch action "run" re-enters the recorded phase over them, action "reset" starts the item over.`,
          "",
        ]
      : []),
    ...(orphans.length > 0
      ? [
          `${orphans.length} progress entr(ies) for id(s) no longer queued: ${orphans.slice(0, STATUS_ORPHAN_LIST).join(", ")}${orphans.length > STATUS_ORPHAN_LIST ? `, +${orphans.length - STATUS_ORPHAN_LIST} more` : ""}. Clear with fr_batch action "reset", only:<id>.`,
          "",
        ]
      : []),
    "audit: frozen contract per item, out-of-contract findings non-blocking, gap set must shrink each round",
    `network retry: ${pol.maxRetries} attempt(s), ${Math.round(pol.baseDelayMs / 1000)}s→${Math.round(pol.maxDelayMs / 1000)}s backoff${pol.probeUrl ? `, probe ${pol.probeUrl}` : ", no probe"}${pol.resumeOnRetry ? ", resume-on-retry" : ", respawn-on-retry"}`,
    `queue (yours):     ${queuePath(cwd)}`,
    `progress (driver): ${progressPath(cwd)}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
