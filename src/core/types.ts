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
  headSha?: string;
  // The PR's own commits, oldest first. Only fetched for repositories with more
  // than one open PR, because its sole purpose is spotting a stack whose PRs
  // were opened against main rather than against each other.
  commitShas?: string[];
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
  // Linear's UUID. Needed to ask for an epic's children, whose filter takes
  // UUIDs rather than the ACME-1234 identifier a PR title carries.
  uuid?: string;
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

// Every sub-ticket of a parent, counted by state. Gathered separately from the
// assigned-issue fetch because an epic's children include tickets assigned to
// nobody, or to someone else, and leaving those out would overstate progress.
export interface EpicRollup {
  parentId: string;
  done: number;
  canceled: number;
  started: number;
  todo: number;
  backlog: number;
  /** Everything that is not canceled — the honest denominator. */
  live: number;
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
  // Set on every PR of a stack, the bottom one included.
  stack?: StackInfo;
  // The epic at the top of the ticket's chain, when that is not the ticket
  // itself. Linear nests deeper than one level, so the immediate parent is not
  // reliably the epic.
  epicId?: string;
  idleDays: number;
}

// One PR's place in a chain of branches stacked on each other.
export interface StackInfo {
  /** Open PRs in the chain, this one included. Never below 2. */
  size: number;
  /** 1-based, counting from the PR that merges first. */
  position: number;
  /** The PR this one is branched off. Absent at the bottom. */
  parent?: PullRequest;
  /** The PRs branched directly off this one. Empty at the top. */
  children: PullRequest[];
}

export interface TicketNode {
  key: string;
  issue?: LinearIssue;
  items: Item[];
}

// One cell of a bay's spine, in ticket order. "done" needs the closed-ticket
// rollup; the rest come from the open PRs.
export type SpineCell = "done" | "cleared" | "needs" | "waiting" | "blocked";

export interface NextMove {
  kind: "merge" | "release" | "fix" | "waiting";
  text: string;
  item?: Item;
}

export interface Group {
  key: string;
  title: string;
  epic?: LinearIssue;
  tickets: TicketNode[];
  count: number;
  repos: number;
  /** How many of the open PRs in this group sit in each lane. */
  lanes: Record<Lane, number>;
  /** Sub-ticket counts across the whole parent, closed ones included. */
  rollup?: EpicRollup;
  /** Set when every open PR in the group is waiting on the same ticket. */
  blockedOn?: string;
  /** The highest score of any PR in the group, for ordering. */
  peak: number;
  /** Read left to right, the shape of the whole effort. */
  spine: SpineCell[];
  /** One sentence: the highest-leverage thing to do here. */
  move: NextMove;
  /**
   * A bay gets its own section; anything else is one row in the singles ledger.
   * An epic earns a bay by having two or more open PRs.
   */
  bay: boolean;
}
