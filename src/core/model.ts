import type {
  EpicRollup,
  Group,
  Item,
  Lane,
  LinearIssue,
  NextMove,
  PullRequest,
  SpineCell,
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

  const items = linked.map(({ pr, issue }) =>
    buildItem(pr, issue, openTickets, issue ? (unblocksMap.get(issue.id) ?? []) : [], now),
  );

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

  // An epic that owns a PR of its own as well as sub-tickets groups under
  // itself, otherwise its own PR strands in "standalone" while its children
  // form a separate group under its name.
  const parentIds = new Set<string>();
  for (const node of byTicket.values()) {
    if (node.issue?.parentId) parentIds.add(node.issue.parentId);
  }

  const byGroup = new Map<string, TicketNode[]>();
  for (const [key, node] of byTicket) {
    let groupKey: string;
    if (key === NO_TICKET) groupKey = NO_TICKET;
    else if (node.issue?.parentId) groupKey = node.issue.parentId;
    else if (parentIds.has(key)) groupKey = key;
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
      // An epic earns its own section by having more than one open PR. A single
      // PR of information gets a single row in the ledger instead.
      bay: Boolean(index.byKey.get(key.toUpperCase())) && groupItems.length > 1,
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


