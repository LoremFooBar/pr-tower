import type { Group, Item, LinearIssue, PullRequest, TicketNode } from "./types";
import { buildIssueIndex, linkPR, prTicketKey } from "./link";
import { buildItem } from "./rank";

const NO_PARENT = " no-parent";
const NO_TICKET = " no-ticket";

const GROUP_TITLE: Record<string, string> = {
  [NO_PARENT]: "Standalone tickets",
  [NO_TICKET]: "No linked ticket",
};

// Worst-first, so a group needing attention sorts above one that is fine.
const LANE_WEIGHT: Record<string, number> = {
  merge: 0,
  send: 1,
  held: 2,
  flight: 3,
  quiet: 4,
};

export interface Model {
  items: Item[];
  groups: Group[];
  /** Ready to send, best first. */
  queue: Item[];
  counts: Record<string, number>;
}

export function buildModel(
  prs: PullRequest[],
  issues: LinearIssue[],
  now = Date.now(),
): Model {
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
    tickets.sort(
      (a, b) =>
        worst(a.items) - worst(b.items) ||
        b.items.reduce(peak, 0) - a.items.reduce(peak, 0) ||
        a.key.localeCompare(b.key, undefined, { numeric: true }),
    );
    groups.push({
      key,
      title: index.byKey.get(key.toUpperCase())?.title ?? GROUP_TITLE[key] ?? key,
      epic: index.byKey.get(key.toUpperCase()),
      tickets,
      count: groupItems.length,
      repos: new Set(groupItems.map((item) => `${item.pr.owner}/${item.pr.repo}`)).size,
    });
  }

  groups.sort((a, b) => {
    const synthetic = (group: Group) => (group.epic ? 0 : group.key === NO_PARENT ? 1 : 2);
    const aItems = a.tickets.flatMap((ticket) => ticket.items);
    const bItems = b.tickets.flatMap((ticket) => ticket.items);
    return (
      synthetic(a) - synthetic(b) ||
      worst(aItems) - worst(bItems) ||
      b.count - a.count ||
      a.title.localeCompare(b.title)
    );
  });

  const queue = items
    .filter((item) => item.lane === "send")
    .sort((a, b) => b.score - a.score || a.pr.number - b.pr.number);

  const counts: Record<string, number> = { total: items.length };
  for (const item of items) counts[item.lane] = (counts[item.lane] ?? 0) + 1;

  return { items, groups, queue, counts };
}

function worst(items: Item[]): number {
  let lowest = 9;
  for (const item of items) lowest = Math.min(lowest, LANE_WEIGHT[item.lane] ?? 9);
  return lowest;
}

function peak(highest: number, item: Item): number {
  return Math.max(highest, item.score);
}
