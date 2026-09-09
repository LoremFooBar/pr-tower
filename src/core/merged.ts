import { matchesQuery, searchableMerged } from "./search";
import type { DeployState, DeployStep, MergedPR } from "./types";

// Anything still moving sorts above anything finished, so a stuck deploy is the
// first row whatever else merged since. Within a band, newest first.
const URGENCY: Record<DeployState, number> = {
  failed: 0,
  waiting: 1,
  running: 2,
  none: 3,
  ok: 4,
};

// Long enough for the names a person wrote — "Template Reference Check" is 24 —
// and short enough to stop a generated one from taking the row. A Dependabot
// run is named after its own commit message and reaches eighty characters.
const LABEL_MAX = 28;

/**
 * What a step is called on a pill and in the collapsed line. An environment is
 * already a word; a workflow name is a sentence, and the run number in it is
 * noise here because the pill links to the run itself.
 */
export function stepLabel(step: DeployStep): string {
  if (step.kind === "environment") return step.name;
  const trimmed = step.name
    .replace(/\s*#\d+\s*$/, "")
    .replace(/\b(pipeline|workflow|deployment|deploy)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const name = trimmed || step.name;
  return name.length > LABEL_MAX ? `${name.slice(0, LABEL_MAX - 1)}…` : name;
}

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
    `${what} — ${stuck.repo} #${stuck.number}${where ? ` ${stepLabel(where)}` : ""}`,
    rest > 0 ? `${rest} more not live` : null,
    live > 0 ? `${live} live` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
