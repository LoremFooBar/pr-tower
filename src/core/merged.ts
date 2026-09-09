import { matchesQuery, searchableMerged } from "./search";
import type { DeployState, MergedPR } from "./types";

// Anything still moving sorts above anything finished, so a stuck deploy is the
// first row whatever else merged since. Within a band, newest first.
const URGENCY: Record<DeployState, number> = {
  failed: 0,
  waiting: 1,
  running: 2,
  none: 3,
  ok: 4,
};

export function mergedView(merged: MergedPR[], query: string): MergedPR[] {
  const shown = query
    ? merged.filter((pr) => matchesQuery(searchableMerged(pr), query))
    : merged;
  return shown
    .slice()
    .sort(
      (a, b) =>
        URGENCY[a.state] - URGENCY[b.state] || Date.parse(b.mergedAt) - Date.parse(a.mergedAt),
    );
}

export function isLive(pr: MergedPR): boolean {
  return pr.state === "ok" || pr.state === "none";
}

/** The step the row is stuck on, which is the one worth naming. */
export function blocker(pr: MergedPR) {
  return pr.steps.find((step) => step.state === pr.state);
}

/**
 * The collapsed line. It leads with whatever is wrong, so the strip does a
 * checklist's job without a checklist's failure mode — an empty section is
 * indistinguishable from a broken fetch, and this always says something.
 */
export function mergedLine(view: MergedPR[], days: number): string {
  if (view.length === 0) {
    return `Nothing merged in the last ${days} ${days === 1 ? "day" : "days"}`;
  }

  const live = view.filter(isLive).length;
  const stuck = view.find((pr) => !isLive(pr));
  if (!stuck) return `${view.length} merged · all live`;

  const where = blocker(stuck);
  const what =
    stuck.state === "failed"
      ? "deploy failed"
      : stuck.state === "waiting"
        ? "waiting for approval"
        : "deploying";
  const rest = view.filter((pr) => !isLive(pr)).length - 1;

  return [
    `${what} — ${stuck.repo} #${stuck.number}${where ? ` ${where.name}` : ""}`,
    rest > 0 ? `${rest} more not live` : null,
    live > 0 ? `${live} live` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
