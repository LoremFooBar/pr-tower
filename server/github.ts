import type { BugbotState, CheckStatus, GitHubUser, PullRequest } from "../src/core/types";

// Overridable so the end-to-end test can point the real server at a local
// stand-in for GitHub instead of reaching the internet.
const REST = process.env.GITHUB_API ?? "https://api.github.com";
const GRAPHQL = `${REST}/graphql`;

// How many PRs are enriched at once. Each one costs four REST calls, so this
// keeps a 30-PR refresh well inside the 5000/hour limit while staying quick.
const ENRICH_CONCURRENCY = 6;

const BUGBOT_CHECK = /bugbot/i;

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export class GitHubError extends Error {}

async function rest<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${REST}${path}`, { headers: headers(token) });
  if (!res.ok) {
    const detail = res.status === 401 ? "Token rejected." : `GitHub returned ${res.status}.`;
    throw new GitHubError(detail);
  }
  return res.json() as Promise<T>;
}

export async function validateToken(token: string): Promise<GitHubUser> {
  return rest<GitHubUser>(token, "/user");
}

interface SearchItem {
  id: number;
  node_id: string;
  number: number;
  title: string;
  html_url: string;
  repository_url: string;
  created_at: string;
  updated_at: string;
  draft?: boolean;
}

interface PRDetail {
  head: { sha: string; ref: string };
  base: { ref: string };
  mergeable_state?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

interface CheckRun {
  name?: string;
  status: string;
  conclusion: string | null;
}

function bugbotVerdict(runs: CheckRun[]): BugbotState {
  const run = runs.find((candidate) => BUGBOT_CHECK.test(candidate.name ?? ""));
  if (!run) return "none";
  if (run.status !== "completed") return "pending";
  if (run.conclusion === "failure" || run.conclusion === "action_required") return "failure";
  return "success";
}

async function enrich(token: string, item: SearchItem): Promise<PullRequest> {
  const [owner, repo] = item.repository_url.split("/repos/")[1].split("/");
  const base: PullRequest = {
    id: item.id,
    nodeId: item.node_id,
    number: item.number,
    title: item.title,
    url: item.html_url,
    owner,
    repo,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    draft: Boolean(item.draft),
    approvals: 0,
    changesRequested: 0,
    checks: "pending",
    failedChecks: [],
    mergeState: "unknown",
    bugbot: "none",
    hasCI: false,
  };

  try {
    const [detail, reviews] = await Promise.all([
      rest<PRDetail>(token, `/repos/${owner}/${repo}/pulls/${item.number}`),
      rest<{ state: string; user: { login: string } }[]>(
        token,
        `/repos/${owner}/${repo}/pulls/${item.number}/reviews?per_page=100`,
      ).catch(() => []),
    ]);

    // Only the latest review per person counts, so a comment after an approval
    // does not silently drop the approval.
    const latest = new Map<string, string>();
    for (const review of reviews) {
      if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") {
        latest.set(review.user.login, review.state);
      }
    }
    base.approvals = [...latest.values()].filter((state) => state === "APPROVED").length;
    base.changesRequested = [...latest.values()].filter((state) => state === "CHANGES_REQUESTED").length;

    base.baseRef = detail.base.ref;
    base.headRef = detail.head.ref;
    base.additions = detail.additions;
    base.deletions = detail.deletions;
    base.changedFiles = detail.changed_files;
    base.mergeState = detail.mergeable_state ?? "unknown";

    const sha = detail.head.sha;
    const [status, checks] = await Promise.all([
      rest<{ state: string; total_count: number }>(token, `/repos/${owner}/${repo}/commits/${sha}/status`)
        .catch(() => ({ state: "pending", total_count: 0 })),
      rest<{ total_count: number; check_runs: CheckRun[] }>(
        token,
        `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`,
      ).catch(() => ({ total_count: 0, check_runs: [] as CheckRun[] })),
    ]);

    base.hasCI = status.total_count > 0 || checks.total_count > 0;
    base.bugbot = bugbotVerdict(checks.check_runs);
    base.failedChecks = checks.check_runs
      .filter((run) => run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "action_required")
      .map((run) => run.name ?? "check");

    const running = checks.check_runs.some((run) => run.status !== "completed");
    base.checks = resolveChecks(status.state, base.hasCI, base.failedChecks.length > 0, running);
  } catch {
    // A single PR failing to enrich must not lose the whole refresh; it shows
    // with unknown state rather than disappearing.
  }

  return base;
}

function resolveChecks(
  commitState: string,
  hasCI: boolean,
  anyFailed: boolean,
  anyRunning: boolean,
): CheckStatus {
  if (!hasCI) return "success";
  if (anyFailed || commitState === "failure" || commitState === "error") return "failure";
  if (anyRunning || commitState === "pending") return "pending";
  return "success";
}

async function pooled<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function fetchMyOpenPRs(
  token: string,
  login: string,
  org: string,
  onProgress?: (done: number, total: number) => void,
): Promise<PullRequest[]> {
  const query = `type:pr author:${login} is:open${org ? ` org:${org}` : ""}`;
  const search = await rest<{ items: SearchItem[] }>(
    token,
    `/search/issues?q=${encodeURIComponent(query)}&per_page=100`,
  );

  let done = 0;
  return pooled(search.items, ENRICH_CONCURRENCY, async (item) => {
    const pr = await enrich(token, item);
    onProgress?.(++done, search.items.length);
    return pr;
  });
}

// Taking a PR out of draft is a GraphQL-only operation — REST has no way to do
// it. This is the one write the app makes.
export async function sendForReview(token: string, nodeId: string): Promise<void> {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `mutation($id: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $id }) {
          pullRequest { number isDraft }
        }
      }`,
      variables: { id: nodeId },
    }),
  });
  if (!res.ok) throw new GitHubError(`GitHub returned ${res.status}.`);
  const body = await res.json();
  if (body.errors?.length) throw new GitHubError(body.errors[0].message);
  if (body.data?.markPullRequestReadyForReview?.pullRequest?.isDraft !== false) {
    throw new GitHubError("GitHub accepted the request but the PR is still a draft.");
  }
}
