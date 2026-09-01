import type {
  EpicRollup,
  Group,
  Item,
  Lane,
  LinearIssue,
  NextMove,
  PullRequest,
  SpineCell,
  StackInfo,
  TicketNode,
} from "./types";
import { buildIssueIndex, linkPR, prTicketKey } from "./link";
import { buildItem } from "./rank";

const NO_PARENT = " no-parent";
const NO_TICKET = " no-ticket";

const GROUP_TITLE: Record<string, string> = {
  [NO_PARENT]: "Standalone tickets",
  [NO_TICKET]: "No linked ticket",
};

// The one ladder every list uses: what you can act on, then what is broken,
// then what is waiting on other people, then what is waiting on your own work.
const LADDER: Record<Lane, number> = {
  merge: 0,
  send: 1,
  held: 2,
  flight: 3,
  quiet: 4,
};

function rung(item: Item): number {
  // A draft blocked by another ticket sorts last, below even the PRs waiting on
  // other people: there is nothing to do about it until that ticket lands.
  if (item.lane === "held" && item.signals.some((signal) => signal.kind === "blocked")) return 3.5;
  return LADDER[item.lane];
}

function byLadder(a: Item, b: Item): number {
  return rung(a) - rung(b) || b.score - a.score || a.pr.number - b.pr.number;
}

// A PR is stacked when its base branch is another open PR's head branch in the
// same repository. GitHub retargets a child at its grandparent the moment the
// parent merges, so a stack only ever describes PRs that are both still open —
// the same way a Linear blocker is spent once its PR lands.
export function stacks(prs: PullRequest[]): Map<number, StackInfo> {
  const branch = (pr: PullRequest, ref: string) => `${pr.owner}/${pr.repo}#${ref}`;

  const byHead = new Map<string, PullRequest>();
  for (const pr of prs) {
    if (pr.headRef) byHead.set(branch(pr, pr.headRef), pr);
  }

  // Second reading, for a stack whose PRs were each opened against main rather
  // than against each other: one PR's commits already contain another's head
  // commit. GitHub is never told about that stack, but git knows.
  const contained = (pr: PullRequest): PullRequest | undefined => {
    const held = pr.commitShas;
    if (!held || held.length === 0) return undefined;
    const shas = new Set(held);

    // In a chain of three the top PR holds both other heads, and only the
    // nearer one is its parent. More commits means nearer. An equal count is
    // two branches at the same commit, which is nobody's parent.
    let nearest: PullRequest | undefined;
    for (const other of prs) {
      if (other.id === pr.id || other.owner !== pr.owner || other.repo !== pr.repo) continue;
      if (!other.headSha || !shas.has(other.headSha)) continue;
      const depth = other.commitShas?.length ?? 0;
      if (depth >= held.length) continue;
      if (!nearest || depth > (nearest.commitShas?.length ?? 0)) nearest = other;
    }
    return nearest;
  };

  const parent = new Map<number, PullRequest>();
  const children = new Map<number, PullRequest[]>();
  for (const pr of prs) {
    const declared = pr.baseRef ? byHead.get(branch(pr, pr.baseRef)) : undefined;
    const above = declared?.id !== pr.id ? (declared ?? contained(pr)) : undefined;
    if (!above || above.id === pr.id) continue;
    parent.set(pr.id, above);
    children.set(above.id, [...(children.get(above.id) ?? []), pr]);
  }

  // Walking up stops at a PR already seen. A branch cannot really be its own
  // ancestor, but a cycle here would hang the whole page.
  const depth = (pr: PullRequest): number => {
    const seen = new Set<number>([pr.id]);
    let steps = 0;
    for (let above = parent.get(pr.id); above && !seen.has(above.id); above = parent.get(above.id)) {
      seen.add(above.id);
      steps++;
    }
    return steps + 1;
  };

  // Everything reachable through a base/head link, in either direction: a stack
  // is the whole chain, not the part above or below any one PR.
  const byId = new Map(prs.map((pr) => [pr.id, pr]));
  const chain = (start: PullRequest): PullRequest[] => {
    const found = new Map<number, PullRequest>([[start.id, start]]);
    const queue = [start];
    while (queue.length > 0) {
      const pr = queue.shift()!;
      const neighbours = [parent.get(pr.id), ...(children.get(pr.id) ?? [])];
      for (const next of neighbours) {
        if (!next || found.has(next.id)) continue;
        found.set(next.id, byId.get(next.id) ?? next);
        queue.push(next);
      }
    }
    return [...found.values()];
  };

  const info = new Map<number, StackInfo>();
  for (const pr of prs) {
    if (info.has(pr.id)) continue;
    const members = chain(pr);
    if (members.length < 2) continue;
    for (const member of members) {
      info.set(member.id, {
        size: members.length,
        position: depth(member),
        parent: parent.get(member.id),
        children: children.get(member.id) ?? [],
      });
    }
  }
  return info;
}

function cellFor(item: Item): SpineCell {
  if (item.lane === "send" || item.lane === "merge") return "cleared";
  if (item.lane === "flight") return "waiting";
  if (item.signals.some((signal) => signal.kind === "blocked")) return "blocked";
  return "needs";
}

// Highest leverage first. Merging something approved beats releasing a draft,
// which beats fixing a break, and an all-waiting group says so plainly.
function nextMove(items: Item[]): NextMove {
  const best = (lane: Lane) =>
    items.filter((item) => item.lane === lane).sort((a, b) => b.score - a.score)[0];

  const mergeable = best("merge");
  if (mergeable) {
    const unblocks = mergeable.unblocks.length
      ? ` (approved; unblocks ${mergeable.unblocks.join(", ")})`
      : " (approved)";
    return { kind: "merge", text: `merge ${label(mergeable)}${unblocks}`, item: mergeable };
  }

  const sendable = best("send");
  if (sendable) return { kind: "release", text: `release ${label(sendable)}`, item: sendable };

  const broken = items
    .filter((item) => item.lane === "held" && !item.signals.some((s) => s.kind === "blocked"))
    .sort((a, b) => b.score - a.score)[0];
  if (broken) {
    const why = broken.gates.find((gate) => !gate.open)?.reason ?? "fix it";
    return { kind: "fix", text: `${label(broken)} — ${lower(why)}`, item: broken };
  }

  const blocked = items.find((item) => item.signals.some((signal) => signal.kind === "blocked"));
  if (blocked) {
    const on = blocked.issue?.blockedBy[0];
    return { kind: "waiting", text: on ? `blocked on ${on}` : "blocked", item: blocked };
  }

  return { kind: "waiting", text: "waiting on reviewers — nothing for you" };
}

function label(item: Item): string {
  return item.issue?.id ?? `${item.pr.repo} #${item.pr.number}`;
}

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export interface Model {
  items: Item[];
  /** Epics with two or more open PRs, in stable priority order. */
  bays: Group[];
  /** Everything else: one-PR epics, standalone tickets, then no-ticket work. */
  singles: Item[];
  noTicket: Item[];
  /** Cleared for release, best first. */
  queue: Item[];
  /** When the queue is empty, the draft closest to clearing. */
  closest?: Item;
  counts: Record<string, number>;
}

export function buildModel(
  prs: PullRequest[],
  issues: LinearIssue[],
  rollups: EpicRollup[] = [],
  now = Date.now(),
): Model {
  const byParent = new Map(rollups.map((rollup) => [rollup.parentId, rollup]));
  const index = buildIssueIndex(issues);
  const linked = prs.map((pr) => ({ pr, issue: linkPR(pr, index) }));

  const openTickets = new Set<string>();
  for (const { pr, issue } of linked) {
    const id = issue?.id ?? prTicketKey(pr);
    if (id) openTickets.add(id.toUpperCase());
  }

  // Which tickets wait on which. Only counts a waiting ticket that itself has an
  // open PR, otherwise landing this one unblocks nothing you are actually holding.
  const unblocksMap = new Map<string, string[]>();
  for (const issue of issues) {
    if (!openTickets.has(issue.id.toUpperCase())) continue;
    for (const blocker of issue.blockedBy) {
      const waiting = unblocksMap.get(blocker) ?? [];
      waiting.push(issue.id);
      unblocksMap.set(blocker, waiting);
    }
  }

  // A bay belongs to the epic at the top of the chain, not to whatever ticket
  // happens to sit one level up. Linear nests as deep as you like: grouping by
  // the immediate parent puts a grandchild in a group of its own, which never
  // reaches the two PRs a bay needs, so it strands in the singles ledger while
  // its siblings sit in the epic's bay.
  const parentOf = new Map(issues.map((issue) => [issue.id, issue.parentId]));
  const rootOf = (id: string): string => {
    // Linear will not make a cycle, but one here would hang the page.
    const seen = new Set<string>([id]);
    let current = id;
    for (;;) {
      const up = parentOf.get(current);
      if (!up || seen.has(up)) return current;
      seen.add(up);
      current = up;
    }
  };

  const stacked = stacks(prs);
  const items = linked.map(({ pr, issue }) => {
    const item = buildItem(pr, issue, openTickets, issue ? (unblocksMap.get(issue.id) ?? []) : [], now);
    const stack = stacked.get(pr.id);
    const key = issue?.id ?? prTicketKey(pr);
    const root = key ? rootOf(key) : undefined;
    return {
      ...item,
      ...(stack ? { stack } : {}),
      ...(root && root !== key ? { epicId: root } : {}),
    };
  });

  const byTicket = new Map<string, TicketNode>();
  for (const item of items) {
    const key = item.issue?.id ?? prTicketKey(item.pr) ?? NO_TICKET;
    let node = byTicket.get(key);
    if (!node) {
      node = { key: key === NO_TICKET ? "" : key, issue: item.issue, items: [] };
      byTicket.set(key, node);
    }
    if (!node.issue && item.issue) node.issue = item.issue;
    node.items.push(item);
  }

  const rootByKey = new Map<string, string>();
  for (const key of byTicket.keys()) {
    if (key !== NO_TICKET) rootByKey.set(key, rootOf(key));
  }

  // How many ticket nodes each epic gathers. An epic that owns a PR as well as
  // sub-tickets groups under itself; alone, it is standalone work.
  const gathered = new Map<string, number>();
  for (const root of rootByKey.values()) gathered.set(root, (gathered.get(root) ?? 0) + 1);

  const byGroup = new Map<string, TicketNode[]>();
  for (const [key, node] of byTicket) {
    const root = rootByKey.get(key);
    let groupKey: string;
    if (key === NO_TICKET) groupKey = NO_TICKET;
    else if (root && root !== key) groupKey = root;
    else if ((gathered.get(key) ?? 0) > 1) groupKey = key;
    else groupKey = NO_PARENT;

    const bucket = byGroup.get(groupKey);
    if (bucket) bucket.push(node);
    else byGroup.set(groupKey, [node]);
  }

  const groups: Group[] = [];
  for (const [key, tickets] of byGroup) {
    const groupItems = tickets.flatMap((ticket) => ticket.items);
    for (const ticket of tickets) ticket.items.sort(byLadder);
    tickets.sort(
      (a, b) =>
        rung(a.items[0]) - rung(b.items[0]) ||
        b.items[0].score - a.items[0].score ||
        a.key.localeCompare(b.key, undefined, { numeric: true }),
    );
    const lanes: Record<Lane, number> = { send: 0, held: 0, flight: 0, merge: 0, quiet: 0 };
    for (const item of groupItems) lanes[item.lane]++;

    const rollup = byParent.get(key);
    // Done cells come from the rollup, which counts siblings this tool never
    // sees because they have no open PR. Without it the spine shows only what
    // is in flight, and no count claims progress.
    const spine: SpineCell[] = [
      ...Array<SpineCell>(rollup?.done ?? 0).fill("done"),
      ...groupItems.slice().sort(byLadder).map(cellFor),
    ];

    // Every open PR waiting on the same ticket means the group as a whole is
    // stuck behind one thing, which is worth saying once rather than per row.
    const blockers = groupItems.map(
      (item) => item.signals.find((signal) => signal.kind === "blocked")?.label ?? "",
    );
    const blockedOn =
      blockers.length > 0 && blockers.every((label) => label && label === blockers[0])
        ? blockers[0]
        : undefined;

    groups.push({
      key,
      title: index.byKey.get(key.toUpperCase())?.title ?? GROUP_TITLE[key] ?? key,
      epic: index.byKey.get(key.toUpperCase()),
      tickets,
      count: groupItems.length,
      repos: new Set(groupItems.map((item) => `${item.pr.owner}/${item.pr.repo}`)).size,
      lanes,
      rollup,
      blockedOn,
      peak: groupItems.reduce((highest, item) => Math.max(highest, item.score), 0),
      spine,
      move: nextMove(groupItems),
      // Two ways to earn a section: more than one open PR, or being a real epic
      // — more than one live sub-ticket — even when only one of them has a PR
      // open right now. The second reading needs the rollup, because the tool
      // never sees a sibling with no open PR.
      bay:
        Boolean(index.byKey.get(key.toUpperCase())) &&
        (groupItems.length > 1 || (rollup?.live ?? 0) > 1),
    });
  }

  // Urgent, High, Medium, Low, then unset — with unset last rather than
  // mid-scale, because an epic nobody prioritised is not a mid-priority epic.
  const priorityRank = (group: Group) => {
    const priority = group.epic?.priority ?? 0;
    return priority === 0 ? 5 : priority;
  };

  const bays = groups
    .filter((group) => group.bay)
    .sort(
      (a, b) =>
        priorityRank(a) - priorityRank(b) ||
        a.key.localeCompare(b.key, undefined, { numeric: true }),
    );

  const inBays = new Set(bays.flatMap((group) => group.tickets.flatMap((t) => t.items)));
  const rest = items.filter((item) => !inBays.has(item));
  const singles = rest.filter((item) => item.issue || prTicketKey(item.pr)).sort(byLadder);
  const noTicket = rest.filter((item) => !item.issue && !prTicketKey(item.pr)).sort(byLadder);

  const queue = items.filter((item) => item.lane === "send").sort(byLadder);

  // When nothing is cleared, name the draft that is nearest to it.
  const closest =
    queue.length === 0
      ? items
          .filter((item) => item.lane === "held")
          .sort((a, b) => {
            const shut = (item: Item) => item.gates.filter((gate) => !gate.open).length;
            return shut(a) - shut(b) || b.score - a.score;
          })[0]
      : undefined;

  const counts: Record<string, number> = { total: items.length };
  for (const item of items) counts[item.lane] = (counts[item.lane] ?? 0) + 1;

  return { items, bays, singles, noTicket, queue, closest, counts };
}


