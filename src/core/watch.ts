import type { MergedPR, PullRequest, StateAlert } from "./types";

/**
 * What happened to the user's PRs between two refreshes: one that merged, one
 * that gained an approval. Both are read by comparing the two lists rather than
 * asked of GitHub, because neither question has an endpoint that answers "since
 * when".
 *
 * `before` is the open PRs of the previous refresh. With none there is nothing
 * to compare against, so the caller passes an empty list and nothing is raised:
 * a fresh container must not announce work that finished before it started.
 */
export function prMoves(
  before: PullRequest[],
  after: PullRequest[],
  merged: MergedPR[],
): StateAlert[] {
  const was = new Map(before.map((pr) => [pr.id, pr]));
  const alerts: StateAlert[] = [];

  for (const pr of merged) {
    if (!was.has(pr.id)) continue;
    alerts.push({
      id: `merged:${pr.id}`,
      kind: "merged",
      prId: pr.id,
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
    });
  }

  for (const pr of after) {
    const previous = was.get(pr.id);
    // A PR whose enrichment failed reports no approvals at all. Without both
    // sides of the comparison being enriched, one failed read followed by a
    // good one announces every approval the PR already had as new.
    if (!previous?.headSha || !pr.headSha) continue;
    const fresh = (pr.approvedBy ?? []).filter((who) => !(previous.approvedBy ?? []).includes(who));
    if (fresh.length === 0) continue;
    alerts.push({
      id: `approved:${pr.id}:${[...fresh].sort().join(",")}`,
      kind: "approved",
      prId: pr.id,
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      by: fresh,
    });
  }

  return alerts;
}
