import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const baseDir = (cwd: string) => join(cwd, ".pi", "fr-batch");
export const queuePath = (cwd: string) => join(baseDir(cwd), "queue.json");
export const progressPath = (cwd: string) => join(baseDir(cwd), "progress.json");
export const runlockPath = (cwd: string) => join(baseDir(cwd), ".run.lock");
/** Append-only record of archived items. One JSON object per line, oldest first. */
export const historyPath = (cwd: string) => join(baseDir(cwd), "history.jsonl");
/** Where an archived item's frozen contract / ledger / out-of-scope notes are parked. */
export const archiveDir = (cwd: string, id: string) => join(baseDir(cwd), "archive", id);
/** The frozen audit contract for one item. Written once, then read-only. */
export const contractPath = (cwd: string, id: string) => join(baseDir(cwd), `${id}.contract.md`);
/** Cross-round gap adjudication for one item. */
export const ledgerPath = (cwd: string, id: string) => join(baseDir(cwd), `${id}.gaps.json`);
/** Auditor findings outside the frozen contract. Human-facing follow-up material. */
export const outOfScopePath = (cwd: string, id: string) => join(baseDir(cwd), `${id}.out-of-scope.md`);

/** Every per-item file this driver owns outside progress.json. */
export function itemStateFiles(cwd: string, id: string): string[] {
  return [contractPath(cwd, id), ledgerPath(cwd, id), outOfScopePath(cwd, id)];
}

/** Write via temp + rename so a concurrent reader never sees a torn file. */
export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}
