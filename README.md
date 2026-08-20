# fr-batch

Sequential FR-PLAN executor with a mechanical test-completeness gate.

**Installed once in user scope, used by every project.** The driver knows no build
system: the verify gate, the repo traps, and the item list all come from the
project's own `<repo>/.pi/fr-batch/queue.json`, and each child gets the project's
`AGENTS.md` / `CLAUDE.md` injected via `inheritProjectContext: true`. Duplicating a
project's build rules into this driver would be exactly the drift that injection
exists to prevent.

```
implement → verify → adversarial audit → [fix → verify → audit]×N → commit → next
```

Nothing here is a judgment call the batch can fudge: the gate is an exit code plus
a JSON field, and the commit only happens when both pass.

## Files and who owns them

All per-project state lives under `<repo>/.pi/fr-batch/`:

| file | owner | contents |
|---|---|---|
| `queue.json` | **you** | items, order, `armed`, budgets, `defaultVerify`, `repoRules`, model/effort config, `transient` policy. The driver only reads it. |
| `progress.json` | **the driver** | per-item `status` / `fixRounds` / `sha` / pause state. You only read it. |
| `history.jsonl` | `archive` | append-only record of swept items: id, plan, sha, commit subject, fixRounds, timestamps, closing note. One JSON object per line, never rewritten. |
| `archive/<id>/` | `archive` | the swept item's frozen contract + gap ledger + out-of-scope notes, moved out of the flat base dir. |
| `<id>.contract.md` | the driver | the item's **frozen audit contract**: the PLAN's `## Tests` matrix as committed at HEAD, before implementation. Written once. |
| `<id>.gaps.json` | the driver | gap adjudication ledger: every gap id ever raised, which rounds raised it, and `open` / `closed` / `rejected` + the fixer's reason. |
| `<id>.out-of-scope.md` | the driver | auditor findings the frozen contract does not ask for. Non-blocking; promote to a follow-up FR if worth having. |
| `.run.lock` | the driver | single-driver interlock. Stale after 15 min; a live driver refreshes it every minute so a long run is never mistaken for a dead one. |
| `<repo>/.pi-subagents/fr-batch/` | the driver | per-child output artifacts and audit verdicts. Intermediate rounds are pruned when the item commits; a blocked item keeps everything. |

The split is not cosmetic — it is what makes **adding an FR while the batch runs**
safe. A single-file design would have the driver write back its in-memory snapshot
on every state transition and silently clobber your append.

## The live pair is sized by work in flight, not by project history

`queue.json` and `progress.json` are on every hot path: the driver re-reads the queue at
every item boundary, and `status` renders from both. A project with hundreds of PLANs that
never sweeps pays for all of them on every single look. Measured on ange's own queue: **409 B
per queue item** and a **354 B prose note per progress entry**, so 300 items is ~123 KB of
queue plus ~106 KB of notes — and, before the summary view, ~300 lines of `status` output per
inspection, of which at most a handful were actionable.

Two mechanisms keep both bounded, and they are independent:

**1. `status` is a summary by default.** It always shows everything not at rest — in flight,
paused, blocked, with the paused item's verbatim question — plus a 3-row preview of what is
next. Committed rows and the deep pending tail fold into one line each that *counts what it
folded*, so nothing is silently omitted:

```
  ⋯ 280  hidden — 280 committed
  … 18. port-ptex-pipeline       fixing        ebb33f7ae fixes:3 verify:default contract:frozen
    19. three-materials          pending       verify:default
  ⋯  57  hidden — 57 pending
```

The render is then the same size for a 342-item queue as for a 31-item one (pinned by
`tests/probe_scale.ts`). `all: true` restores every row; `only: "<id>"` trades the listing for
one item in depth — resolved verify commands, model per role, gap ledger summary, and the
**whole** note instead of its first line. That last one is the reason not to read `queue.json`
by hand.

**2. `archive` sweeps committed items out.**

```
fr_batch { action: "archive" }                   # every committed item
fr_batch { action: "archive", only: "L1-rock" }  # just one
fr_batch { action: "history" }                   # newest 20, one line each
fr_batch { action: "history", limit: 100 }
fr_batch { action: "history", only: "L1-rock" }  # one item in full, incl. its closing note
```

The committed item leaves `queue.json` and `progress.json`, and a line lands in
`history.jsonl` carrying its sha, commit subject, fixRounds, timestamps and closing note. Its
frozen contract and gap ledger are **moved**, not deleted, to `archive/<id>/` — a contract
runs to tens of KB and is the retrospective evidence for the commit.

Why JSONL and append-only: archiving item 400 costs what archiving item 1 did, a torn or
hand-mangled line loses **one** item instead of failing the parse of the whole file, and
`grep '"id":"foo"' history.jsonl` answers the common question without loading anything.
Nothing on the status path reads it — only a line count, for the `N archived` chip.

Why it is a separate action and not automatic on commit: *the driver only reads `queue.json`*
is the entire safety argument for editing the queue mid-run. Sweeping from inside the driver
would make it a writer. Conversely `archive` **refuses while a driver is live or a fresh
`.run.lock` is present** — unlike `add` / `remove`, it deletes from `progress.json`, which the
driver read-modify-writes at every phase transition, so a sweep landing between its read and
its write would be silently undone and the entries would come back as orphans. Archiving is
retrospective work; waiting for the batch to end costs nothing.

Re-queueing an id that is already in history is allowed — a PLAN can grow a follow-up phase —
but `add` says so, with the sha it committed as, because the queue no longer carries that
evidence.

## Why the audit loop terminates

The audit is adversarial on purpose, which makes its termination a design problem
rather than a matter of the auditor being satisfied. Three rules give the loop a fixed
point:

1. **The contract is frozen before the first audit.** `<id>.contract.md` snapshots the
   PLAN's `## Tests` matrix from HEAD. The fixer is still told to append rows to the live
   PLAN — that keeps the document truthful — but those rows are not in the contract, so
   they cannot come back as new demands.
2. **Only in-contract ids can block.** A gap whose `id` does not appear verbatim in the
   frozen contract is recorded in `<id>.out-of-scope.md` and dropped from the gate. This is
   enforced in the driver, not just asked for in the prompt.
3. **The gap set must shrink, and nothing is re-litigated.** The ledger remembers every id
   and the rounds that raised it. A re-raised id, or a round whose in-contract gap count did
   not fall, stops the batch for a human instead of spending another round. The fixer's
   `rejected` list is durable, so an invalid gap dies once instead of every round.

Without (1) the loop has no fixed point at all: the fixer adds matrix rows and production
branches while closing gaps, and an auditor judged against the live PLAN then demands tests
for both. `maxFixRounds` only hides that as "blocked after N rounds".

## Disk footprint

The driver's own files are KB-scale and self-pruning (intermediate round artifacts go away
when an item commits; `remove` and `reset` take an item's state with them).

The real cost is upstream: **every child spawn leaves ~1-2MB of transcript in pi-subagents'
artifact root**, and its default `artifactDir: "project"` writes to `<repo>/.pi-subagents/`
which is *not* age-scanned — it grows forever. Set this once in
`~/.pi/agent/extensions/subagent/config.json`:

```json
{ "artifactDir": "session" }
```

That moves artifacts under the pi session directory, which `cleanupAllArtifactDirs` does
age-clean. Existing `<repo>/.pi-subagents/artifacts/` content is not migrated — delete it by
hand once.

## The run is a background driver

`action: "run"` starts the loop and **returns immediately**. Everything else in this
document depends on that: pi delivers a queued user message only "after the current
assistant turn finishes executing its tool calls", so a tool that awaited a multi-hour
batch would freeze the supervising conversation for the whole batch — every message you
typed would sit in the steering queue, and `status`, `add`, `remove` and `stop` could not
run at all. The live append this queue was built for was unreachable from the session that
started the run.

Nothing in the loop needed the turn: children are already async subagent runs, and every
phase transition is already persisted in `progress.json`. The two things the turn did
provide are replaced explicitly — esc-abort by `action: "stop"`, the streaming card by
`action: "status"`.

- **One driver per repo**, enforced by `.run.lock` plus in-process state; a second `run`
  reports what the live one is doing instead of starting a rival.
- **Fast refusals still come back inline.** A disarmed queue, a dirty tree or a held lock
  settles within a 2 s grace window, and that text is the tool result — not a notification
  arriving after the tool already said "started".
- **The driver reports back on its own** when it finishes, pauses, or needs a decision: a
  TUI notification plus a `followUp` message that wakes a turn only once the conversation
  is idle. Do not poll `status` in a loop.
- **A quit or `/reload` ends the driver** (`session_shutdown` aborts it and drops the lock).
  The item's phase is in `progress.json`, so the next `run` resumes from it.

## Stopping a run

```
fr_batch { action: "stop" }        # graceful: end after the current child settles
fr_batch { action: "stop" }        # again: abandon that child now
```

Two steps, because **the driver cannot kill what it launched**: pi-subagents' RPC `stop`
refuses a running workflow ("not controlled by this extension runtime") and children are
spawned as workflows.

- The **first** stop is free of loss. The in-flight child runs to completion (bounded by
  `childTimeoutMs`), then the batch ends at the next phase boundary with its progress
  saved. `run` resumes; no `reset` needed.
- The **second** stop only stops the driver *waiting*. The child is **abandoned, not
  killed** — it may keep editing the tree for a while, so let it settle before the next
  run. The item is recorded as `paused` with `pauseKind: "stopped"` and **no child id**:
  reviving an orphan that may still be alive would put two children in one tree, so the
  next run re-enters that phase fresh over whatever it left on disk.

Flipping `armed` to `false` mid-run is the third, coarsest stop: the driver exits at the
next **item** boundary.

## Use

```
/fr-batch                  # status: summary — in flight, next few pending, driver state
/fr-batch all              # status with every queue row
/fr-batch plan             # dry run: what would execute, in order
/fr-batch run              # start the background driver (needs armed: true)
/fr-batch stop             # end it (twice to hard-stop)
/fr-batch archive          # sweep committed items into history.jsonl
/fr-batch history          # list archived items, newest first
```

or through the tool, which is what the command delegates to:

```
fr_batch { action: "status" }                        # summary
fr_batch { action: "status", all: true }             # every row
fr_batch { action: "status", only: "L1-rock" }       # one item in depth, full note
fr_batch { action: "plan" }
fr_batch { action: "run" }                          # returns at once; the batch runs on
fr_batch { action: "stop" }
fr_batch { action: "continue" }                     # after a network pause
fr_batch { action: "continue", only: "L1-rock",     # after a DECISION NEEDED stop
           answer: "Vendor the .ptex; the transcription is a reference artifact, not the shipped material." }
fr_batch { action: "add", plan: "docs/FR_x_PLAN.md", verify: ["scons", "scons test"] }
fr_batch { action: "add", plan: "...", model: "anthropic/claude-sonnet-4-5", thinking: "high" }
fr_batch { action: "add", plan: "...", after: "L0b-vertex-channels" }
fr_batch { action: "remove", only: "L1-rock" }
fr_batch { action: "reset",  only: "L1-tree" }       # redo from scratch
fr_batch { action: "archive" }                       # committed items → history.jsonl
fr_batch { action: "history", only: "L1-rock" }
```

`remove` only takes an item that is `pending` or `blocked`. One that is mid-flight needs a
`stop` first, and one that is `paused` holds uncommitted work — `reset` it before removing
it, or those edits are orphaned with no queue entry that explains them. A **committed** item
is not removable at all: `archive` is its exit, and it keeps the record.

## Arming

`queue.json` should ship with `"armed": false` and `run` refuses. Set it to `true` only
when you actually want the batch writing to this repo, and only when **no other
session is working in it** — the implementer edits the tree in place, and two
writers corrupt each other.

Flipping `armed` back to `false` mid-run is a **graceful stop**: the driver
finishes nothing new and exits at the next item boundary. For a finer one, use
`action: "stop"` — it ends the batch at the next *phase* boundary.

## Adding an FR mid-run

The driver re-reads `queue.json` at every item boundary, so `action: "add"` lands
on the next iteration with no restart. Two guard rails:

- Order matters here (L0 → L0b → L0c → L1s), so `add` takes `after` / `before`.
  An insert that would land only among already-committed items is **refused**, not
  silently accepted, because the driver picks the first uncommitted item and would
  never reach it.
- Omitting `verify` inherits `queue.defaultVerify`. That is visible in `status` as
  `verify:default` — an item's real gate should usually come from its PLAN's own
  "Build, validate, test" section.

## Per-project configuration

`queue.json` carries everything repo-specific:

- **`defaultVerify`** — the project's acceptance gate. Take it from the project's
  own context file rather than inventing one (ANGE: `scons` / `scons test`; a
  React Native repo: `npm run lint` / `npx tsc --noEmit` / `npx jest`).
- **`repoRules`** — optional emphasis appended to every child's task. Use it ONLY
  for a trap the context file already documents but agents keep ignoring: a stale
  incremental-build cache, a required codegen step. Do **not** restate the context
  file here; `inheritProjectContext: true` already injects it.
- **`transient`** — network retry policy (see below).
- **`defaultModel` / `defaultThinking` / `roles`** — which model and reasoning effort
  each child runs on (see below).

## Model and reasoning effort per child

Configure nothing and every child runs on **the model and effort of the conversation that
started the batch**. That inheritance is explicit, not incidental: pi-subagents passes the
parent's *model* down on its own but not its *effort*, so leaving it implicit would inherit
half the setting and quietly run a 30-hour batch at the global default effort.

Four layers, most specific first, and **each field resolves on its own**:

```
item.roles[role]  →  item  →  queue.roles[role]  →  queue.default*  →  this session
```

```json
{
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "defaultThinking": "medium",
  "roles": { "auditor": { "thinking": "high" } },
  "items": [
    { "id": "L0-base", "plan": "docs/FR_base_PLAN.md" },
    { "id": "L1-hard", "plan": "docs/FR_hard_PLAN.md",
      "model": "anthropic/claude-opus-4-1", "thinking": "high",
      "roles": { "fixer": { "thinking": "low" } } }
  ]
}
```

- **Three roles, not four phases**: `implementer`, `auditor`, `fixer`. Both fix phases
  (verify-red and audit-gap) are the same agent doing the same job, so one knob covers them.
- Per-**field** resolution is what makes `roles: { auditor: { thinking: "high" } }` compose
  with a batch-wide `defaultModel` instead of having to restate it.
- `"model": "sonnet-4-5:high"` is read as model + effort, so a more specific layer can
  still override just the effort.
- `"model": "inherit"` sets no model at that layer, so
  `{ "defaultModel": "inherit", "defaultThinking": "high" }` means "this session's model, at
  high effort".
- Efforts are pi's own: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. An
  unrecognised one is **rejected when the queue loads**, not dropped in silence — the
  failure it prevents is a queue that reads as configured while every child runs on the
  default.
- The effort travels as the `:<effort>` suffix on the model id, because that is the only
  channel pi-subagents' spawn RPC has for it. So an effort with no model anywhere to carry
  it cannot be delivered; the driver logs that instead of pretending it applied.
- `status` prints the resolved baseline plus what `inherit` currently means, and chips only
  the items that differ from it. `plan` prints the resolved value per item.
- A **resumed** child (network pause, decision pause) keeps the model it launched with:
  `resume` revives a retained session, it does not re-decide its contract.

## Network outages

The layering is deliberate and the reason is a hard constraint: **a model-API
outage cannot be reported by the subagent, because the reporter is the thing that
broke.** The child is a `pi --mode json -p` subprocess; when its model call fails
the failure is in the harness and the model never gets a turn in which it could
call `contact_supervisor`.

So:

| failure locus | detection | recovery |
|---|---|---|
| model API (the common case) | post-mortem, from the child's `error` / `modelAttempts[].error` | driver backs off, then **`resume`s** the same child — its session, context, and already-written files are intact |
| a tool the child ran (fetch, install, clone) | the child reports it via `contact_supervisor` with a `NETWORK_DOWN:` message and blocks | driver holds it blocked through the same backoff, then writes the reply file to release it |

Three layers, three jobs:

- **pi's in-child retry** (`retry.maxRetries: 3`, `baseDelayMs: 2000` → ~14 s) is
  the *blip* filter. Left alone on purpose; a single 502 should not wake the driver.
- **this driver** is the *outage* handler: exponential backoff with full jitter,
  `transient.maxRetries` attempts, `baseDelayMs → maxDelayMs`.
- **you** are the last resort: after the retries are spent the item is persisted
  as `paused` and the driver asks. In a TUI you get a confirm dialog; headless or
  after 10 minutes it returns with instructions and you resume with
  `fr_batch { action: "continue" }`.

`transient.probeUrl` is optional. Set it to something on the path to your model
provider and a recovered network shortens the wait instead of idling out the full
backoff. Left empty, the retry attempt is itself the probe.

Classification is a **conservative allowlist** (`ECONNRESET`, `ENOTFOUND`,
`EAI_AGAIN`, `socket hang up`, `fetch failed`, `429`, `502/503/504`, `overloaded`,
`rate limit`, …). Anything unmatched is treated as a real failure, because
retrying a real failure wastes an hour and hides a bug. Bare `timeout` is
deliberately **not** a signature — our own wall-clock expiry is a budget problem
that needs human eyes, not another 90-minute attempt.

`fallbackModels` is empty on all three agents on purpose: switching models during
an outage is pure waste and disguises one outage as "several models failed for
real".

That rule predates per-role models, and a fallback across *different providers* is
not the same outage twice — so it is an open question rather than a settled ban. It
stays unconfigured, and these two mechanical facts bound anyone revisiting it:

- **A fallback list is static, agent-scoped config.** `buildModelCandidates()` reads
  `agent.fallbackModels`; no `spawn` / RPC / workflow-child param carries one. So
  "fall back to whatever the supervising session runs" cannot be written in pi's own
  fallback mechanism at all — only fr-batch knows the live session.
- **A driver-side fallback cannot resume.** pi's in-child fallback re-invokes with the
  same `--session <file>`, so the second model continues the transcript and sees what
  the first already wrote. RPC `resume` takes `{ id, message }` and reads the model
  from the persisted descriptor, so a model switch here means a **fresh** child over a
  half-edited tree — losing the work preservation this layer exists for.

## A PLAN with no test matrix is refused before anything runs

`ange`-style PLANs are graded by their `## Tests` behavior-branch matrix: the implementer is
told to turn every row into a real test, and the auditor may only raise a gap that NAMES a row
of the frozen contract. A PLAN with no matrix therefore has no test obligation to satisfy and
an audit gate that passes by vacuity — it would report a green item that was never checked.

So the driver reads the PLAN **before spawning any child** and blocks the item if it has no
tests section, or a tests section with no rows. Nothing is written and nothing is committed;
the message names the PLAN and what to add.

The heading is matched by its TEXT, not by an exact spelling — `## 6. Tests — the branch
matrix` and `### Tests` both count. That matters: the original `^## Tests$`-only matcher
silently treated 10 of the first 15 committed items as "no matrix" and froze the WHOLE PLAN as
the audit contract, announced by one log line in a 24-line rolling window.

## A decision the driver cannot make

A child that hits a real blocker — a PLAN row whose premise is false, a prerequisite that does
not exist in the tree — is told to call `contact_supervisor({ reason: "need_decision", ... })`
rather than guess. The driver **cannot** answer that: it is a batch driver, not a supervisor,
and the operator's answer can be hours away. Leaving the child blocked on its channel that long
is not an option either — pi-subagents detaches a child waiting on an unanswered ask, the
driver then saw only `status: "paused"`, and the item was blocked with `Implementer ended with
status "paused". Summary: Detached for intercom coordination before task completion.` — the
question itself reached nobody and lived only inside the child's own report file.

So the driver watches for **every** unanswered ask, not just `NETWORK_DOWN:` ones:

1. a non-network ask is released immediately with a directive: stop, and write the question,
   the options you measured and your recommendation into your report;
2. the item is persisted as a **decision** pause with the question verbatim (`pendingAsk`),
   and the child's run id, so it can be revived;
3. the question is reported to the supervising session verbatim — inline when the pause
   happens inside the grace window, otherwise through the driver's own `followUp` message.
   `action: "status"` shows it too, for as long as the item stays paused;
4. `action: "continue"` **refuses** such an item without `answer:` (reviving the child without
   its answer just makes it ask again). With `answer:`, that exact child session is revived and
   told the decision is binding — its context and already-written files are intact.

The post-outcome sweep of the channel matters: a child that detaches the instant it asks can
finish inside the watcher's 3 s poll gap, and the unanswered request file outlives it. That
sweep is what stops the question from being lost in exactly the case the child could not
report itself.

## Stopping conditions

| outcome | meaning | tree | next items |
|---|---|---|---|
| `committed` | verify green, audit found nothing in the frozen contract | clean | continue |
| `paused` (network) | network unreachable after the retries | holds this item's work | not started |
| `paused` (decision) | a child asked a question only you can answer | holds this item's work | not started |
| `paused` (stopped) | you hard-stopped the driver mid-child; that child was abandoned, not killed | holds this item's work, plus whatever the abandoned child was mid-way through writing | not started |
| `blocked` | PLAN missing / has no test matrix (nothing ran); verify still red; audit still finds in-contract gaps after `maxFixRounds`; or the audit is **not converging** (an adjudicated id was re-raised, or the gap count did not fall) | holds this item's work | not started |

`blocked` and `paused` both stop the batch — later items depend on the earlier one
landing. Neither commits anything.

A non-convergence block is not a budget timeout: it means the loop cannot terminate on its
own. Read `<id>.gaps.json` — either the fixer's closing test really is vacuous (fix it by
hand) or the auditor is re-litigating a settled row (record the rejection in the ledger).

## The modules

One file per concern, dependencies pointing one way. `index.ts` is a registration shim and
declares nothing of its own — so "where does this behaviour live" is answered by the file list,
not by scrolling.

| file | lines | what |
|---|---|---|
| `index.ts` | 264 | `registerTool` + `registerCommand` + `session_shutdown`. The architecture note at the top is the map. |
| `driver.ts` | 754 | `runBatch` — the item loop: gate, freeze, implement, verify, audit, fix rounds, commit. |
| `resilience.ts` | 420 | transient-failure signatures, backoff, connectivity probe, the child's supervisor-ask channel, `NetworkPause`. |
| `contract.ts` | 279 | the frozen audit contract, the gap ledger, out-of-scope recording, verdict parsing. |
| `rpc.ts` | 274 | pi-subagents' in-process RPC: spawn a child, resolve on completion. |
| `types.ts` | 271 | every interface, both JSON schemas, the shared constants. No logic. |
| `queue_ops.ts` | 265 | `add` / `remove` / `reset` / `archive` — the only writers of `queue.json`. |
| `store.ts` | 261 | on-disk state: queue, progress, history, run lock, artifact pruning. |
| `render.ts` | 248 | `status` (summary / all / one item) and `history` rendering. |
| `background.ts` | 188 | start / stop / finish the background driver, and how it reports back. |
| `prompts.ts` | 144 | the three agents' task text. Prose, not logic. |
| `config.ts` | 128 | the model + reasoning-effort layer stack. |
| `state.ts` | 70 | live-driver registry and its formatters. The only shared mutable state. |
| `paths.ts` | 30 | every path under `.pi/fr-batch/`, plus `writeAtomic`. |

Three invariants hold the split together, all pinned by `tests/probe_modules.ts`:

- **No import cycle.** A cycle typechecks and then fails as an undefined binding at load
  time, in a user's session. (The probe rejects type-only back-edges too — those cannot break
  at runtime, but they mean the boundary is drawn wrong; `SupervisorAsk` moved to `types.ts`
  for exactly that reason.)
- **Only `index.ts` imports a *value* from a pi package.** This is what lets the probes
  import the real modules under plain node: `import type` is erased before resolution, a
  value import is not.
- **No TS constructor parameter properties.** They are a runtime feature node's
  type-stripping loader cannot execute.

## After editing

```bash
cd ~/.pi/agent/extensions/fr-batch
/opt/homebrew/lib/node_modules/typescript/bin/tsc -p tsconfig.json   # typecheck (include: ["*.ts"])
node tests/run.mjs                                                  # guard tests
```

`tests/run.mjs` runs six probe files against the real modules and throwaway git repos — 195
assertions. It covers the supervisor-ask classification and reply file, the detach marker, the
tests-section matcher, the pre-flight gate, `runBatch`'s decision-pause refusal, the
model/effort layer stack (both in isolation and end-to-end into the spawn params of every
role), the background driver's whole lifecycle (immediate return, mid-run `add`, graceful vs
hard `stop`, the resumable stopped pause, one-notification-per-run, the run-lock heartbeat),
the module invariants above, and the scale contract: that `status` renders the same number of
lines for a 342-item queue as for a 31-item one while never folding an actionable row, and
that an `archive` sweep moves the record to `history.jsonl` without losing a note, a contract
file, or a refusal. Each fix it covers was verified to turn it RED when reverted.

The probes `import { runBatch } from "../driver.ts"` directly. They used to run against a
regenerated *copy* of a single 3.5k-line `index.ts` with three fragments rewritten to make it
executable — a copy that bailed out with "index.ts no longer contains the text this harness
rewrites" on any reformat, and that needed an appended export block to reach module-private
functions. The split removed the whole mechanism.

Then `/reload` in any running session to pick the change up — **but not while a batch is
running**: the driver is an in-process loop, and `session_shutdown` aborts it.

`tsconfig.json` maps the three pi packages out of the global install, so this works
without a local `npm install`. `allowImportingTsExtensions` is on because pi resolves
`./x.ts` specifiers as written.
