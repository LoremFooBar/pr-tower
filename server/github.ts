import type {
  BugbotState,
  CheckStatus,
  CommentAlert,
  CommentKind,
  GitHubUser,
  PullRequest,
  Reviewer,
} from "../src/core/types";

// Overridable so the end-to-end test can point the real server at a local
// stand-in for GitHub instead of reaching the internet.
const REST = process.env.GITHUB_API ?? "https://api.github.com";
const GRAPHQL = `${REST}/graphql`;

// How many PRs are enriched at once. Each one costs four REST calls, so this
// keeps a 30-PR refresh well inside the 5000/hour limit while staying quick.
const ENRICH_CONCURRENCY = 6;

const BUGBOT_CHECK = /bugbot/i;

// Bugbot comments under its own account rather than a name of its own choosing.
// `cursor` is anchored with the bot suffix so a person of that name is still a
// person; `bugbot` is matched loosely because the account has been renamed once.
const BUGBOT_AUTHOR = /bugbot|^cursor\[bot\]$/i;

// A notification body is two lines on every desktop. Past this it is cut off by
// the operating system rather than by us.
const EXCERPT_MAX = 160;

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

// The three places a remark on a PR can live. Kept apart because the ids are
// three separate sequences: without the surface a review and an inline note can
// collide and one of them would never be announced.
type Surface = "issue" | "inline" | "review";

interface ReviewRow {
  id?: number;
  state: string;
  body?: string | null;
  html_url?: string;
  submitted_at?: string | null;
  user: { login: string; type?: string; avatar_url?: string };
}

// One comment, whichever surface it came from. Review submissions are mapped
// onto this shape at the fetch site, so everything downstream reads one thing.
export interface RawComment {
  surface: Surface;
  id: number;
  html_url: string;
  body?: string | null;
  created_at: string;
  user?: { login: string; type?: string } | null;
  /** Set on an issue comment: /repos/o/r/issues/N. */
  issue_url?: string;
  /** Set on an inline comment and on a mapped review: /repos/o/r/pulls/N. */
  pull_request_url?: string;
}

interface CheckRun {
  id?: number;
  name?: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
}

/**
 * The check-runs API's `latest` filter dedupes within one check suite, and a
 * workflow re-triggered on the same commit lands in a suite of its own — so a
 * superseded failure comes back alongside the passing re-run that replaced it.
 * GitHub's own PR view keeps only the newest run of each name; without this a
 * PR reads as failing forever. Ids increase with creation, which breaks the tie
 * when two runs share a start time.
 */
export function latestPerName(runs: CheckRun[]): CheckRun[] {
  const newest = new Map<string, CheckRun>();
  for (const run of runs) {
    const name = run.name ?? "check";
    const seen = newest.get(name);
    if (!seen || newer(run, seen)) newest.set(name, run);
  }
  return [...newest.values()];
}

function newer(run: CheckRun, than: CheckRun): boolean {
  const at = Date.parse(run.started_at ?? "") || 0;
  const seen = Date.parse(than.started_at ?? "") || 0;
  return at === seen ? (run.id ?? 0) > (than.id ?? 0) : at > seen;
}

function bugbotVerdict(runs: CheckRun[]): BugbotState {
  const run = runs.find((candidate) => BUGBOT_CHECK.test(candidate.name ?? ""));
  if (!run) return "none";
  if (run.status !== "completed") return "pending";
  if (run.conclusion === "failure" || run.conclusion === "action_required") return "failure";
  return "success";
}

async function enrich(
  token: string,
  item: SearchItem,
  login: string,
): Promise<{ pr: PullRequest; notes: RawComment[] }> {
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

  let notes: RawComment[] = [];

  try {
    const [detail, reviews] = await Promise.all([
      rest<PRDetail>(token, `/repos/${owner}/${repo}/pulls/${item.number}`),
      rest<ReviewRow[]>(
        token,
        `/repos/${owner}/${repo}/pulls/${item.number}/reviews?per_page=100`,
      ).catch(() => [] as ReviewRow[]),
    ]);

    // A review submitted with a message lives only here — neither comments
    // endpoint lists it — so "changes requested: please fix X" would otherwise
    // arrive silently. This call is already made, so the notes cost nothing.
    notes = reviews
      .filter((review) => (review.body ?? "").trim() !== "")
      .map((review) => ({
        surface: "review" as const,
        id: review.id ?? 0,
        html_url: review.html_url ?? item.html_url,
        body: review.body,
        created_at: review.submitted_at ?? item.updated_at,
        user: review.user,
        pull_request_url: `${REST}/repos/${owner}/${repo}/pulls/${item.number}`,
      }));

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

    // Anyone who submitted a review, whatever its verdict — GitHub records a
    // lone inline comment as a review of state COMMENTED, so this is what
    // "somebody is reading it" looks like. A plain comment in the conversation
    // box is not a review and does not appear here.
    const people = new Map<string, string | undefined>();
    for (const review of reviews) {
      const who = review.user.login;
      if (review.user.type === "Bot" || who.endsWith("[bot]") || who === login) continue;
      if (!people.has(who)) people.set(who, review.user.avatar_url);
    }
    base.reviewers = [...people].map(([who, avatar]) => ({ login: who, avatar }));

    base.baseRef = detail.base.ref;
    base.headRef = detail.head.ref;
    base.headSha = detail.head.sha;
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

    const runs = latestPerName(checks.check_runs);

    base.hasCI = status.total_count > 0 || runs.length > 0;
    base.bugbot = bugbotVerdict(runs);
    base.failedChecks = runs
      .filter((run) => run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "action_required")
      .map((run) => run.name ?? "check");

    const running = runs.some((run) => run.status !== "completed");
    base.checks = resolveChecks(
      status.state,
      status.total_count,
      runs.length,
      base.failedChecks.length > 0,
      running,
    );
  } catch {
    // A single PR failing to enrich must not lose the whole refresh; it shows
    // with unknown state rather than disappearing.
  }

  return { pr: base, notes };
}

/**
 * The combined-status API answers `state: "pending"` for a commit that has no
 * legacy statuses at all — which is every repository running only GitHub
 * Actions. Its state therefore means nothing unless `total_count` says there is
 * something to report, and reading it unconditionally marks every PR in such a
 * repository as "checks still running" forever.
 */
export function resolveChecks(
  commitState: string,
  commitCount: number,
  checkRunsCount: number,
  anyFailed: boolean,
  anyRunning: boolean,
): CheckStatus {
  if (commitCount === 0 && checkRunsCount === 0) return "success";
  const legacy = commitCount > 0 ? commitState : "";
  if (anyFailed || legacy === "failure" || legacy === "error") return "failure";
  if (anyRunning || legacy === "pending") return "pending";
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

// A stack is only visible in the commits when the PRs sit in one repository, so
// a repository holding a single open PR is skipped and costs nothing. The list
// comes back oldest first, which is the end a parent's commits live at.
async function addCommits(token: string, prs: PullRequest[]): Promise<void> {
  const perRepo = new Map<string, PullRequest[]>();
  for (const pr of prs) {
    const key = `${pr.owner}/${pr.repo}`;
    perRepo.set(key, [...(perRepo.get(key) ?? []), pr]);
  }

  const candidates = [...perRepo.values()].filter((group) => group.length > 1).flat();
  await pooled(candidates, ENRICH_CONCURRENCY, async (pr) => {
    const commits = await rest<{ sha: string }[]>(
      token,
      `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/commits?per_page=100`,
    ).catch(() => [] as { sha: string }[]);
    pr.commitShas = commits.map((commit) => commit.sha);
  });
}

// Avatars are inlined rather than linked: the page's CSP allows no external
// image, and one decoration is not worth being the first thing the page fetches
// from another host. Cached across refreshes by URL, so a returning reviewer
// costs nothing; the cache is unbounded only in the number of people who have
// ever reviewed one of your PRs.
const avatarCache = new Map<string, string>();

// Only GitHub's own avatar host, or whatever stands in for the API in a test.
// The URL arrives inside an API response, and nothing that comes from outside
// should be able to point the server at an address of its choosing.
function avatarAllowed(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.hostname === "avatars.githubusercontent.com" || raw.startsWith(REST);
  } catch {
    return false;
  }
}

async function inlineAvatar(raw: string): Promise<string | undefined> {
  const cached = avatarCache.get(raw);
  if (cached) return cached;
  if (!avatarAllowed(raw)) return undefined;

  try {
    // A 40px render is all a row shows, and s= keeps the payload tiny.
    const url = new URL(raw);
    if (!url.searchParams.has("s")) url.searchParams.set("s", "48");
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return undefined;

    const type = res.headers.get("content-type") ?? "image/png";
    if (!type.startsWith("image/")) return undefined;
    const bytes = Buffer.from(await res.arrayBuffer());
    // An avatar is a few kB. Anything this large is not one, and the snapshot
    // is written to disk on every refresh.
    if (bytes.byteLength > 128 * 1024) return undefined;

    const inlined = `data:${type};base64,${bytes.toString("base64")}`;
    avatarCache.set(raw, inlined);
    return inlined;
  } catch {
    return undefined;
  }
}

async function addAvatars(prs: PullRequest[]): Promise<void> {
  const wanted = new Map<string, Reviewer[]>();
  for (const pr of prs) {
    for (const reviewer of pr.reviewers ?? []) {
      if (!reviewer.avatar) continue;
      wanted.set(reviewer.avatar, [...(wanted.get(reviewer.avatar) ?? []), reviewer]);
    }
  }

  await pooled([...wanted.keys()], ENRICH_CONCURRENCY, async (raw) => {
    const inlined = await inlineAvatar(raw);
    for (const reviewer of wanted.get(raw) ?? []) reviewer.avatar = inlined;
  });
}

export async function fetchMyOpenPRs(
  token: string,
  login: string,
  org: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ prs: PullRequest[]; notes: RawComment[] }> {
  const query = `type:pr author:${login} is:open${org ? ` org:${org}` : ""}`;
  const search = await rest<{ items: SearchItem[] }>(
    token,
    `/search/issues?q=${encodeURIComponent(query)}&per_page=100`,
  );

  let done = 0;
  const enriched = await pooled(search.items, ENRICH_CONCURRENCY, async (item) => {
    const one = await enrich(token, item, login);
    onProgress?.(++done, search.items.length);
    return one;
  });

  const prs = enriched.map((one) => one.pr);

  // A failure in either costs a decoration or the commit-derived stacks, never
  // the refresh: the base branch still names the stacks GitHub was told about,
  // and a reviewer without a picture is still named.
  await Promise.all([addCommits(token, prs).catch(() => {}), addAvatars(prs).catch(() => {})]);
  return { prs, notes: enriched.flatMap((one) => one.notes) };
}

/**
 * Who wrote a comment, or null for an author not worth waking someone for: the
 * user's own remarks, and every bot that is not Bugbot.
 */
export function authorKind(
  login: string,
  type: string | undefined,
  self: string,
): CommentKind | null {
  if (!login || login === self) return null;
  if (BUGBOT_AUTHOR.test(login)) return "bugbot";
  if (type === "Bot" || login.endsWith("[bot]")) return null;
  return "person";
}

function targetOf(comment: RawComment): string | null {
  const url = comment.pull_request_url ?? comment.issue_url ?? "";
  const match = /\/repos\/([^/]+)\/([^/]+)\/(?:pulls|issues)\/(\d+)/.exec(url);
  return match ? `${match[1]}/${match[2]}#${match[3]}` : null;
}

// A notification renders no markdown and no HTML, so Bugbot's heading markers,
// its bold severity and the metadata block it trails arrive as litter in front
// of the sentence that matters.
function excerptOf(body: string | null | undefined): string {
  const flat = (body ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!--[\s\S]*$/, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX - 1)}…` : flat;
}

/**
 * Collapses raw comments into one arrival per author per PR, dropping anything
 * already announced, older than the cursor, or written by someone who does not
 * warrant a notification.
 *
 * The cursor is compared against `created_at`, not `updated_at`, even though the
 * API filters on the latter: an edited old comment comes back with a fresh
 * `updated_at`, and announcing it would claim something new was said.
 *
 * `keys` is every comment that fed an alert, for the caller to remember.
 */
export function groupComments(
  comments: RawComment[],
  prs: PullRequest[],
  self: string,
  since: string,
  seen: Set<string>,
): { alerts: CommentAlert[]; keys: string[] } {
  const byNumber = new Map(prs.map((pr) => [`${pr.owner}/${pr.repo}#${pr.number}`, pr]));
  const floor = Date.parse(since);
  const keys: string[] = [];
  const groups = new Map<
    string,
    { pr: PullRequest; kind: CommentKind; author: string; newest: RawComment; count: number }
  >();

  for (const comment of comments) {
    const key = `${comment.surface}:${comment.id}`;
    if (seen.has(key)) continue;
    const at = Date.parse(comment.created_at ?? "");
    if (!Number.isFinite(at) || (Number.isFinite(floor) && at < floor)) continue;

    const target = targetOf(comment);
    const pr = target ? byNumber.get(target) : undefined;
    if (!pr) continue;

    const login = comment.user?.login ?? "";
    const kind = authorKind(login, comment.user?.type, self);
    if (!kind) continue;

    keys.push(key);
    const groupKey = `${pr.id}\u0000${login}`;
    const group = groups.get(groupKey);
    if (!group) {
      groups.set(groupKey, { pr, kind, author: login, newest: comment, count: 1 });
      continue;
    }
    group.count += 1;
    if (at > Date.parse(group.newest.created_at)) group.newest = comment;
  }

  const alerts = [...groups.values()]
    .map((group) => ({
      id: `${group.newest.surface}:${group.newest.id}`,
      prId: group.pr.id,
      repo: group.pr.repo,
      number: group.pr.number,
      title: group.pr.title,
      url: group.newest.html_url,
      author: group.author,
      kind: group.kind,
      count: group.count,
      excerpt: excerptOf(group.newest.body),
      at: group.newest.created_at,
    }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return { alerts, keys };
}

/**
 * Both comment endpoints are per repository rather than per PR, so a sweep costs
 * two calls for a repository holding twenty open PRs as readily as for one
 * holding a single PR. A page of 100 is a sweep's worth of conversation at the
 * five-minute refresh; anything beyond it is picked up as the newest 100 next
 * time round.
 */
export async function fetchNewComments(
  token: string,
  prs: PullRequest[],
  since: string,
): Promise<RawComment[]> {
  const repos = [...new Set(prs.map((pr) => `${pr.owner}/${pr.repo}`))];
  const query = `?since=${encodeURIComponent(since)}&sort=updated&direction=desc&per_page=100`;

  const pages = await pooled(repos, ENRICH_CONCURRENCY, async (repo) => {
    const [conversation, inline] = await Promise.all([
      rest<RawComment[]>(token, `/repos/${repo}/issues/comments${query}`).catch(
        () => [] as RawComment[],
      ),
      rest<RawComment[]>(token, `/repos/${repo}/pulls/comments${query}`).catch(
        () => [] as RawComment[],
      ),
    ]);
    // The issues endpoint answers for plain issues too; grouping drops anything
    // that is not one of the PRs in hand.
    return [
      ...conversation.map((comment) => ({ ...comment, surface: "issue" as const })),
      ...inline.map((comment) => ({ ...comment, surface: "inline" as const })),
    ];
  });

  return pages.flat();
}

// Moving a PR in or out of draft is GraphQL-only — REST cannot do either. These
// are the only writes the app makes.
async function draftMutation(
  token: string,
  nodeId: string,
  field: "markPullRequestReadyForReview" | "convertPullRequestToDraft",
  expectDraft: boolean,
): Promise<void> {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `mutation($id: ID!) {
        ${field}(input: { pullRequestId: $id }) { pullRequest { number isDraft } }
      }`,
      variables: { id: nodeId },
    }),
  });
  if (!res.ok) throw new GitHubError(`GitHub returned ${res.status}.`);
  const body = await res.json();
  if (body.errors?.length) throw new GitHubError(body.errors[0].message);
  if (body.data?.[field]?.pullRequest?.isDraft !== expectDraft) {
    throw new GitHubError(
      expectDraft
        ? "GitHub accepted the request but the PR is still out for review."
        : "GitHub accepted the request but the PR is still a draft.",
    );
  }
}

export function sendForReview(token: string, nodeId: string): Promise<void> {
  return draftMutation(token, nodeId, "markPullRequestReadyForReview", false);
}

export function convertToDraft(token: string, nodeId: string): Promise<void> {
  return draftMutation(token, nodeId, "convertPullRequestToDraft", true);
}
