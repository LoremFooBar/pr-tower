import type { LinearIssue, PullRequest } from "./types";

// A ticket key such as ACME-1032 at the very start of a title, possibly behind
// an opening bracket. Anchored, so a key mentioned mid-sentence is not mistaken
// for the PR's own ticket.
const TICKET_AT_START = /^[^A-Za-z0-9]*([A-Za-z]{2,10})-(\d+)\b/;

// Same key, plus whatever separator follows it, for stripping the prefix off a
// title that is already labelled by its ticket badge.
const TICKET_PREFIX = /^[^A-Za-z0-9]*[A-Za-z]{2,10}-\d+[\])]?\s*[:\-–—]?\s*/;

export function parseTicketKey(text: string): string | null {
  const match = TICKET_AT_START.exec(text);
  return match ? `${match[1].toUpperCase()}-${match[2]}` : null;
}

// The ticket a PR belongs to, by title first and branch second. Both carry it:
// the title because the verify-title check rejects a PR without one, the branch
// because that is what Linear itself matches on.
export function prTicketKey(pr: PullRequest): string | null {
  return parseTicketKey(pr.title) ?? (pr.headRef ? parseTicketKey(pr.headRef) : null);
}

export function stripTicketPrefix(title: string): string {
  return title.replace(TICKET_PREFIX, "").trim() || title;
}

const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;

// Sub-pages, query strings and fragments all collapse to the canonical PR URL,
// so an attachment Linear recorded as .../pull/592/files still matches.
export function canonicalPRUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.hostname !== "github.com") return null;
    const match = PR_PATH.exec(url.pathname);
    return match ? `${match[1]}/${match[2]}#${match[3]}` : null;
  } catch {
    return null;
  }
}

export interface IssueIndex {
  byPRUrl: Map<string, LinearIssue>;
  byKey: Map<string, LinearIssue>;
}

export function buildIssueIndex(issues: LinearIssue[]): IssueIndex {
  const byPRUrl = new Map<string, LinearIssue>();
  const byKey = new Map<string, LinearIssue>();
  for (const issue of issues) {
    byKey.set(issue.id.toUpperCase(), issue);
    for (const url of issue.prUrls) {
      const canonical = canonicalPRUrl(url);
      if (canonical) byPRUrl.set(canonical, issue);
    }
  }
  return { byPRUrl, byKey };
}

// Linear's own attachment is the authoritative link — it is the exact PR URL,
// written by the integration. The key parsed from the title or branch is the
// fallback for a PR the integration never attached.
export function linkPR(pr: PullRequest, index: IssueIndex): LinearIssue | undefined {
  const canonical = canonicalPRUrl(pr.url);
  const key = prTicketKey(pr);
  const named = key ? index.byKey.get(key) : undefined;

  // Two tickets can claim one PR — a parent and the child it was opened for
  // both list the URL — and the index can only keep the last one it read. When
  // the PR names one of the claimants in its own title or branch, that is the
  // ticket the developer meant, and the answer stops depending on the order
  // Linear happened to return the issues in.
  if (named && canonical && named.prUrls.some((url) => canonicalPRUrl(url) === canonical)) {
    return named;
  }

  const attached = canonical ? index.byPRUrl.get(canonical) : undefined;
  return attached ?? named;
}
