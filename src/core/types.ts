export interface GitHubUser {
  login: string;
  avatar_url: string;
}

export type CheckStatus = "success" | "failure" | "pending";

// Cursor Bugbot's verdict on the PR's current head commit. "none" means it has
// no result on *this* commit — normal on a draft, which Bugbot skips, and worth
// flagging on a PR that is already out for review.
export type BugbotState = "success" | "failure" | "pending" | "none";

export interface PullRequest {
  id: number;
  // GraphQL node id. Required to mark a PR ready for review — REST cannot.
  nodeId: string;
  number: number;
  title: string;
  url: string;
  repo: string;
  owner: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  baseRef?: string;
  headRef?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  approvals: number;
  changesRequested: number;
  checks: CheckStatus;
  failedChecks: string[];
  // Raw GitHub mergeable_state: clean | behind | dirty | blocked | unstable |
  // unknown. Kept whole because `behind` alone cannot tell a conflict from a
  // merely stale branch, and `mergeable` lies.
  mergeState: string;
  bugbot: BugbotState;
  hasCI: boolean;
}

export type LinearStateType =
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

export interface LinearIssue {
  id: string;
  title: string;
  url: string;
  stateName: string;
  stateType: LinearStateType;
  // 0 none, 1 urgent, 2 high, 3 medium, 4 low — Linear's own scale.
  priority: number;
  parentId?: string;
  projectName?: string;
  blockedBy: string[];
  prUrls: string[];
}

export type SignalKind =
  | "merge"
  | "conflict"
  | "red"
  | "checks_running"
  | "no_bot"
  | "blocked"
  | "drift"
  | "behind"
  | "idle";

export interface Signal {
  kind: SignalKind;
  label: string;
  detail: string;
}

// The three gates a draft must clear before it can go out for review. They are
// deliberately few: these are the things that make a review a waste of someone
// else's time, not everything that could be improved.
export type GateName = "ci" | "merge" | "path";

export interface Gate {
  name: GateName;
  open: boolean;
  label: string;
  reason: string;
}

export interface ScorePart {
  label: string;
  points: number;
}

export type Lane =
  | "send" // draft, all gates open — ready to go out
  | "held" // draft, a gate is shut
  | "flight" // already out for review
  | "merge" // approved and mergeable
  | "quiet"; // draft with nothing wrong, just not moving

export interface Item {
  pr: PullRequest;
  issue?: LinearIssue;
  gates: Gate[];
  ready: boolean;
  signals: Signal[];
  lane: Lane;
  score: number;
  scoreParts: ScorePart[];
  // Ticket ids of the user's other open PRs waiting on this one.
  unblocks: string[];
  idleDays: number;
}

export interface TicketNode {
  key: string;
  issue?: LinearIssue;
  items: Item[];
}

export interface Group {
  key: string;
  title: string;
  epic?: LinearIssue;
  tickets: TicketNode[];
  count: number;
  repos: number;
}
