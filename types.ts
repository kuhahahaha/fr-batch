/** Driver-synthesised gap id. Machinery, not scope: never filtered as out-of-contract. */
export const UNPARSEABLE_GAP_ID = "AUDIT-UNPARSEABLE";

export type ItemStatus = "pending" | "implementing" | "verifying" | "auditing" | "fixing" | "paused" | "blocked" | "committed";

/** Which child was in flight when a transient failure paused the item. */
export type Phase = "implement" | "audit" | "fix-verify" | "fix-audit";

/**
 * Reasoning efforts pi accepts. Same list as pi's own THINKING_LEVELS
 * (pi-subagents src/shared/model-info.ts) — an effort outside it is rejected at
 * queue load, because an unrecognised one is silently dropped downstream.
 */
export const THINKING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];

/**
 * Which fr-* agent a child runs as. One knob per ROLE, not per phase: the verify-fix and
 * gap-fix phases are the same agent doing the same job over the same tree, so splitting
 * them would offer a choice with nothing behind it.
 */
export type ChildRole = "implementer" | "auditor" | "fixer";
export const CHILD_ROLES: readonly ChildRole[] = ["implementer", "auditor", "fixer"];
/** Short role labels for one-line status/plan output. */
export const ROLE_LABEL: Record<ChildRole, string> = { implementer: "impl", auditor: "audit", fixer: "fix" };

/**
 * Model + reasoning effort for one child. Both optional at every layer; each field is
 * resolved independently against the layer stack (see resolveChildConfig).
 */
export interface ChildConfig {
  /** `provider/id`, or a bare id pi's registry resolves. A trailing `:<effort>` counts as `thinking`. */
  model?: string;
  thinking?: ThinkingEffort;
}

export type RoleConfigs = Partial<Record<ChildRole, ChildConfig>>;

/** Queue entry — user-owned. No mutable execution state lives here. */
export interface QueueItem {
  id: string;
  plan: string;
  fr?: string;
  reads?: string[];
  /** Omit or leave empty to inherit queue.defaultVerify. Shown as "(default)" in status. */
  verify?: string[];
  commitMsg?: string;
  /** This item's model, for every role that does not override it. Omit to inherit. */
  model?: string;
  /** This item's reasoning effort, for every role that does not override it. Omit to inherit. */
  thinking?: ThinkingEffort;
  /** Per-role override inside this item — the most specific layer there is. */
  roles?: RoleConfigs;
}

/** Transient-failure policy. Applies to subagent launches only — see isTransient(). */
export interface TransientPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Optional HEAD probe used to shorten a wait once connectivity returns. "" = no probe. */
  probeUrl: string;
  /** Prefer reviving the failed child over respawning it, so its work is not redone. */
  resumeOnRetry: boolean;
}

export interface Queue {
  /** Hard interlock. `run` refuses while false. Flipping it to false mid-run stops gracefully. */
  armed: boolean;
  maxFixRounds: number;
  childTimeoutMs: number;
  verifyTimeoutMs: number;
  /** Used by any item that omits `verify`. Never empty — an empty gate is no gate. */
  defaultVerify: string[];
  /**
   * Optional per-repo emphasis appended to every child's task. Use it ONLY for a
   * trap the project's context file already documents but agents keep ignoring
   * (a stale incremental-build cache, a required codegen step). Do not restate
   * the context file here — `inheritProjectContext: true` already injects it, and
   * a second copy is a drift source.
   */
  repoRules?: string;
  transient?: Partial<TransientPolicy>;
  /** Batch-wide model for every child that does not override it. Omit to inherit the session's. */
  defaultModel?: string;
  /** Batch-wide reasoning effort. Omit to inherit the session's. */
  defaultThinking?: ThinkingEffort;
  /** Batch-wide per-role override, e.g. a cheaper auditor than implementer. */
  roles?: RoleConfigs;
  items: QueueItem[];
}

export const TRANSIENT_DEFAULTS: TransientPolicy = {
  maxRetries: 6,
  baseDelayMs: 15_000,
  maxDelayMs: 300_000,
  probeUrl: "",
  resumeOnRetry: true,
};

export interface ProgressEntry {
  status: ItemStatus;
  fixRounds: number;
  note?: string;
  sha?: string;
  updatedAt: string;
  /** Set only while status is "paused": enough to resume the exact child that died. */
  pausedPhase?: Phase;
  pausedChildId?: string;
  pausedRound?: number;
  /**
   * Why it paused. "network" waits for connectivity and can resume itself; "decision" waits
   * for a supervisor answer and CANNOT resume without one, so `continue` refuses until it is
   * given an `answer`; "stopped" is a hard stop the operator asked for, and it deliberately
   * keeps no child id — the abandoned child may still be alive, so reviving it is unsafe and
   * the phase is re-run fresh over the files it already wrote.
   */
  pauseKind?: "network" | "decision" | "stopped";
  /** The child's question, verbatim. Set only for a "decision" pause. */
  pendingAsk?: string;
}

export type Progress = Record<string, ProgressEntry>;

/**
 * One archived item. Deliberately FLAT and self-contained: the queue entry and the driver's
 * progress entry are both deleted when this is written, so a line has to carry everything a
 * later reader could want. Read back only by action "history", never on the status path.
 */
export interface HistoryEntry {
  id: string;
  plan: string;
  sha?: string;
  commitMsg?: string;
  fixRounds: number;
  /** ProgressEntry.updatedAt at archive time — when the item reached `committed`. */
  committedAt?: string;
  archivedAt: string;
  /** The driver's closing note, verbatim. The single biggest field, and why this is not JSON. */
  note?: string;
  /** Relative dir under .pi/fr-batch/ holding the frozen contract + ledger, when kept. */
  stateDir?: string;
}

export interface AuditGap {
  id: string;
  kind: string;
  what: string;
  why_missing: string;
  suggested_row: string;
}

export interface AuditVerdict {
  verdict: "complete" | "gaps_found";
  gaps: AuditGap[];
  notes?: string;
}

export type GapState = "open" | "closed" | "rejected";

/** One adjudicated gap. Survives across rounds, runs, and sessions. */
export interface LedgerEntry {
  kind: string;
  what: string;
  /** Every audit round that raised this id. Length > 1 means the loop is not converging. */
  raisedRounds: number[];
  state: GapState;
  /** The fixer's reason, when it declared the gap invalid rather than closing it. */
  reason?: string;
}

export type Ledger = Record<string, LedgerEntry>;

export interface SupervisorAsk {
  channelDir: string;
  requestId: string;
  reason?: string;
  message?: string;
  /** True when the ask is an outage report the driver can answer itself by waiting. */
  isNetwork: boolean;
}

export const AUDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "gaps"],
  properties: {
    verdict: {
      type: "string",
      enum: ["complete", "gaps_found"],
      description:
        "complete = every branch/boundary/clamp/error-code/composition row in the PLAN's ## Tests matrix has a real, non-vacuous test. gaps_found = at least one is missing, vacuous, or unreachable.",
    },
    gaps: {
      type: "array",
      description:
        "One entry per missing or vacuous test FOR A ROW OF THE FROZEN CONTRACT. Empty iff verdict is complete. Coverage the frozen contract does not ask for belongs in notes, not here.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "what", "why_missing", "suggested_row"],
        properties: {
          id: {
            type: "string",
            description:
              "Row id copied VERBATIM from the frozen audit contract in the task. An id that does not appear there is discarded by the driver as out-of-scope, so inventing one wastes the round.",
          },
          kind: {
            type: "string",
            enum: ["branch", "boundary", "clamp", "error_code", "surface_form", "composition", "vacuous", "missing_seam"],
          },
          what: { type: "string", description: "The untested behaviour, one sentence." },
          why_missing: { type: "string", description: "Why current tests do not cover it. Cite the test file/case you inspected." },
          suggested_row: { type: "string", description: "The matrix row to add, including its `proves non-vacuous` RED edit." },
        },
      },
    },
    notes: {
      type: "string",
      description:
        "Anything that is not a blocking gap: coverage you would want but the frozen contract does not ask for, and anything the fixer needs as background. Recorded as a follow-up, never blocking.",
    },
  },
} as const;

/**
 * The fixer's structured report. Its `rejected` list is what lets an invalid gap
 * DIE: a free-form "I think gap 3 is bogus" in a markdown report is read by nobody,
 * so the next audit re-raises it forever.
 */
export const FIX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["closed", "rejected"],
  properties: {
    closed: {
      type: "array",
      description: "One entry per gap you actually closed.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "how"],
        properties: {
          id: { type: "string", description: "The gap id, verbatim from the list you were given." },
          how: { type: "string", description: "The test you wrote and the edit that makes it RED." },
        },
      },
    },
    rejected: {
      type: "array",
      description:
        "One entry per gap you did NOT close because you judged it invalid. This is durable: the next audit is told not to re-raise it, so give a reason that stands on its own.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "why"],
        properties: {
          id: { type: "string", description: "The gap id, verbatim." },
          why: { type: "string", description: "Why it is not a real gap. Cite the test file/case that already covers it, or the reason the demand is unreachable." },
        },
      },
    },
    notes: { type: "string", description: "Optional: an existing test you believe is wrong but did NOT edit, or anything the driver should surface." },
  },
} as const;

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

export type Log = (line: string) => void;
