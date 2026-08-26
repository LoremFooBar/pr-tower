import type {
  Gate,
  Item,
  Lane,
  LinearIssue,
  PullRequest,
  ScorePart,
  Signal,
} from "./types";

// A PR with no movement for this long has stopped being work in progress and
// started being something you have forgotten.
const IDLE_DAYS = 14;

// Ticket states that contradict an open PR. Only the "started" family (In
// Progress, In Review, Rollout) is consistent with one.
const DRIFT_STATES = new Set(["backlog", "unstarted", "completed", "canceled"]);

export function daysBetween(iso: string, now: number): number {
  return Math.floor((now - new Date(iso).getTime()) / 86_400_000);
}

export interface Context {
  issue?: LinearIssue;
  // Ticket ids that still have an open PR of yours. A blocker only counts while
  // the ticket blocking you has not landed.
  openTickets: Set<string>;
  // Ticket ids waiting on this PR's ticket.
  unblocks: string[];
  now: number;
}

// The three gates. Everything else is advice; these are the conditions under
// which asking someone to review would waste their time.
export function gatesFor(pr: PullRequest, context: Context): Gate[] {
  const blockers = context.issue?.blockedBy.filter((id) => context.openTickets.has(id)) ?? [];

  const ci: Gate =
    pr.checks === "failure"
      ? { name: "ci", open: false, label: "CI", reason: pr.failedChecks[0] ? `${pr.failedChecks[0]} failed` : "A check failed" }
      : pr.checks === "pending"
        ? { name: "ci", open: false, label: "CI", reason: "Checks still running" }
        : { name: "ci", open: true, label: "CI", reason: "All checks green" };

  const merge: Gate =
    pr.mergeState === "dirty"
      ? { name: "merge", open: false, label: "Merge", reason: "Conflicting with the base branch" }
      : { name: "merge", open: true, label: "Merge", reason: "No conflicts" };

  const path: Gate =
    blockers.length > 0
      ? { name: "path", open: false, label: "Path", reason: `Waiting on ${blockers.join(", ")}` }
      : { name: "path", open: true, label: "Path", reason: "Nothing blocking it" };

  return [ci, merge, path];
}

export function signalsFor(pr: PullRequest, context: Context, gates: Gate[]): Signal[] {
  const signals: Signal[] = [];
  const shut = (name: string) => gates.find((gate) => gate.name === name && !gate.open);

  if (pr.mergeState === "dirty") {
    signals.push({ kind: "conflict", label: "Conflict", detail: "Conflicting with the base branch." });
  }
  if (pr.checks === "failure") {
    signals.push({
      kind: "red",
      label: "Check failed",
      detail: pr.failedChecks.length > 0
        ? `${pr.failedChecks.join(", ")} failed.`
        : "A check is red.",
    });
  }
  if (pr.checks === "pending") {
    signals.push({ kind: "checks_running", label: "Checks running", detail: "Waiting on CI to finish." });
  }

  const pathGate = shut("path");
  if (pathGate) {
    signals.push({ kind: "blocked", label: "Blocked", detail: pathGate.reason + "." });
  }

  // Bugbot does not run on drafts, so a missing verdict is only meaningful once
  // the PR is out for review — and never in a repo that runs no CI at all.
  if (!pr.draft && pr.bugbot === "none" && pr.hasCI) {
    signals.push({
      kind: "no_bot",
      label: "No Bugbot",
      detail: "Out for review, but Bugbot has no result on this commit.",
    });
  }
  if (pr.bugbot === "failure") {
    signals.push({ kind: "no_bot", label: "Bugbot flagged it", detail: "Bugbot reported problems on this commit." });
  }

  if (!pr.draft && pr.approvals > 0 && pr.changesRequested === 0 && pr.checks === "success" && pr.mergeState === "clean") {
    signals.push({ kind: "merge", label: "Merge now", detail: "Approved, green, and mergeable." });
  }

  if (context.issue && DRIFT_STATES.has(context.issue.stateType)) {
    signals.push({
      kind: "drift",
      label: "Ticket drift",
      detail: `The PR is open but ${context.issue.id} sits in ${context.issue.stateName}.`,
    });
  }

  if (pr.mergeState === "behind") {
    signals.push({ kind: "behind", label: "Behind base", detail: "The base branch has moved on." });
  }

  const idle = daysBetween(pr.updatedAt, context.now);
  if (idle >= IDLE_DAYS) {
    signals.push({ kind: "idle", label: `Idle ${idle}d`, detail: `No update in ${idle} days.` });
  }

  return signals;
}

// Linear's priority scale, weighted so that an unset priority is not read as
// unimportant — it sits just under Medium rather than at the bottom.
const PRIORITY_POINTS: Record<number, { points: number; label: string }> = {
  1: { points: 40, label: "Urgent" },
  2: { points: 28, label: "High priority" },
  3: { points: 16, label: "Medium priority" },
  4: { points: 6, label: "Low priority" },
  0: { points: 13, label: "No priority set" },
};

const STARTED_POINTS = 12;
const UNSTARTED_POINTS = 4;
const UNBLOCK_POINTS = 25;
const UNBLOCK_CAP = 50;
const AGE_POINTS_PER_DAY = 0.6;
const AGE_CAP = 18;

// How much this PR matters, as a handful of named parts rather than one opaque
// number — the parts are what the row shows, so the ranking can be argued with.
export function scoreFor(context: Context, idle: number): ScorePart[] {
  const parts: ScorePart[] = [];
  const issue = context.issue;

  const priority = PRIORITY_POINTS[issue ? issue.priority : 0];
  parts.push({ label: issue ? priority.label : "No ticket", points: issue ? priority.points : 8 });

  if (context.unblocks.length > 0) {
    parts.push({
      label: `Unblocks ${context.unblocks.join(", ")}`,
      points: Math.min(context.unblocks.length * UNBLOCK_POINTS, UNBLOCK_CAP),
    });
  }

  if (issue?.stateType === "started") {
    parts.push({ label: issue.stateName, points: STARTED_POINTS });
  } else if (issue?.stateType === "unstarted") {
    parts.push({ label: issue.stateName, points: UNSTARTED_POINTS });
  }

  if (idle > 0) {
    parts.push({
      label: idle === 1 ? "Idle 1 day" : `Idle ${idle} days`,
      points: Math.round(Math.min(idle * AGE_POINTS_PER_DAY, AGE_CAP)),
    });
  }

  return parts;
}

function laneFor(pr: PullRequest, ready: boolean, signals: Signal[]): Lane {
  if (signals.some((signal) => signal.kind === "merge")) return "merge";
  if (!pr.draft) return "flight";
  if (!ready) return "held";
  return "send";
}

export function buildItem(
  pr: PullRequest,
  issue: LinearIssue | undefined,
  openTickets: Set<string>,
  unblocks: string[],
  now: number,
): Item {
  const context: Context = { issue, openTickets, unblocks, now };
  const gates = gatesFor(pr, context);
  const ready = gates.every((gate) => gate.open);
  const signals = signalsFor(pr, context, gates);
  const idleDays = daysBetween(pr.updatedAt, now);
  const scoreParts = scoreFor(context, idleDays);
  const score = scoreParts.reduce((total, part) => total + part.points, 0);

  return {
    pr,
    issue,
    gates,
    ready,
    signals,
    lane: laneFor(pr, ready, signals),
    score,
    scoreParts,
    unblocks,
    idleDays,
  };
}
