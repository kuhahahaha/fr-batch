// Guard probes for the MODULE SPLIT itself. Three invariants, each of which was a real
// constraint while splitting index.ts and each of which is silently violable later:
//
//   1. No import cycle. The split was drawn so dependencies point one way
//      (types → paths → store/config → contract/rpc → resilience → prompts → driver →
//      background/queue_ops/render → index). A cycle still "works" until module-init order
//      matters, and then it fails as an undefined binding at load time, in a user's session.
//   2. Only index.ts may import a VALUE from a pi package. That is what lets every probe
//      import the real modules under plain node: `import type` is erased before resolution,
//      a value import is not. Break it and the guard suite goes back to rewriting source
//      text to make it runnable.
//   3. No TS parameter properties. `constructor(readonly x: T)` is a runtime feature node's
//      type-stripping loader cannot execute; NetworkPause had to be rewritten for it.
//
// Plus: index.ts stays a registration shim, so "where does this behaviour live" is never
// answered with "somewhere in the entry point".
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let fails = 0;
const ok = (n: string, c: boolean, extra = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${extra ? ` — ${extra}` : ""}`);
  if (!c) fails++;
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(root).filter((f) => f.endsWith(".ts"));
const src = new Map(files.map((f) => [f, readFileSync(join(root, f), "utf8")]));

ok("the extension is split into modules, not one file", files.length >= 10, `${files.length} module(s): ${files.join(" ")}`);
ok("index.ts is present as the entry point", files.includes("index.ts"));

// 1. import graph is acyclic
const deps = new Map<string, string[]>();
for (const [f, text] of src) {
  deps.set(
    f,
    [...text.matchAll(/^import(?: type)? [^;]*? from "\.\/([\w.]+\.ts)";/gm)].map((m) => m[1]),
  );
}
const cycle: string[] = [];
const seen = new Set<string>();
const stack: string[] = [];
const walk = (f: string): boolean => {
  if (stack.includes(f)) {
    cycle.push(...stack.slice(stack.indexOf(f)), f);
    return true;
  }
  if (seen.has(f)) return false;
  seen.add(f);
  stack.push(f);
  for (const d of deps.get(f) ?? []) if (walk(d)) return true;
  stack.pop();
  return false;
};
const hasCycle = [...src.keys()].some((f) => {
  stack.length = 0;
  return walk(f);
});
ok("the module import graph is acyclic", !hasCycle, cycle.join(" → "));
ok("...and every local import resolves to a real module", [...deps.values()].flat().every((d) => src.has(d)), [...deps.values()].flat().filter((d) => !src.has(d)).join(", "));

// 2. value imports from pi packages live in index.ts alone
const PI_PKGS = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"];
const valueImportsPi = (text: string) =>
  [...text.matchAll(/^import (type )?[^;]*? from "([^"]+)";/gm)].filter((m) => !m[1] && PI_PKGS.includes(m[2])).map((m) => m[2]);
for (const [f, text] of src) {
  const hits = valueImportsPi(text);
  if (f === "index.ts") ok("index.ts owns the pi value imports", hits.length > 0, hits.join(", "));
  else ok(`${f} imports no pi VALUE (so probes can run it under node)`, hits.length === 0, hits.join(", "));
}

// 3. no constructor parameter properties anywhere
for (const [f, text] of src) {
  const bad = /constructor\s*\([^)]*\b(readonly|public|private|protected)\b/s.test(text);
  if (bad) ok(`${f} has no TS parameter properties`, false, "node's type stripping cannot execute them");
}
ok("no module uses TS constructor parameter properties", ![...src.values()].some((t) => /constructor\s*\([^)]*\b(readonly|public|private|protected)\b/s.test(t)));

// index.ts is registration only
const idx = src.get("index.ts")!;
const topLevel = [...idx.matchAll(/^(?:export )?(?:async )?(function|const|class|interface|type) (\w+)/gm)].map((m) => m[2]);
ok("index.ts declares no logic of its own", topLevel.length === 0, topLevel.join(", "));
ok("...and it does register the tool and the command", idx.includes("registerTool") && idx.includes("registerCommand"));
ok("...and it is a shim, not a module in disguise", idx.split("\n").length < 400, `${idx.split("\n").length} lines`);

// every module is reachable from index.ts: an orphan module is dead code that still typechecks
const reachable = new Set<string>();
const reach = (f: string) => {
  if (reachable.has(f)) return;
  reachable.add(f);
  for (const d of deps.get(f) ?? []) reach(d);
};
reach("index.ts");
const orphans = files.filter((f) => !reachable.has(f));
ok("every module is reachable from index.ts", orphans.length === 0, orphans.join(", "));

console.log(fails === 0 ? "\nprobe_modules: all pass" : `\nprobe_modules: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
