import type { Data, EpicRollup, LinearHealth, LinearIssue, LinearStateType } from "../src/core/types";

const API = process.env.LINEAR_API ?? "https://api.linear.app/graphql";
const PAGE_SIZE = 100;
const MAX_PAGES = 6;

export class LinearError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

// A rate limit or a five-hundred is the same request arriving at a bad moment,
// and one of them silently emptying the board costs every epic on it. A
// rejected key is not retried: it will be rejected again.
const ATTEMPTS = 3;
const BACKOFF_MS = 400;
const TIMEOUT_MS = 20_000;

interface RawState {
  name: string;
  type: string;
}

interface RawParent {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number | null;
  state: RawState | null;
  project: { name: string } | null;
}

interface RawIssue extends RawParent {
  parent: RawParent | null;
  attachments: { nodes: { url: string }[] };
  inverseRelations: { nodes: { type: string; issue: { identifier: string } | null }[] };
}

async function once<T>(key: string, query: string, variables: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API, {
      method: "POST",
      // A personal API key goes in Authorization raw. "Bearer" is for OAuth
      // access tokens only, and Linear rejects it here.
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new LinearError(err instanceof Error ? err.message : "Linear is unreachable.", true);
  }
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) throw new LinearError("Key rejected.");
    throw new LinearError(`Linear returned ${res.status}.`, res.status === 429 || res.status >= 500);
  }
  const body = await res.json();
  if (body.errors?.length) {
    const first = body.errors[0];
    const code = String(first?.extensions?.code ?? "");
    throw new LinearError(first.message, code === "RATELIMITED" || code === "INTERNAL_SERVER_ERROR");
  }
  if (!body.data) throw new LinearError("Linear returned no data.", true);
  return body.data as T;
}

async function graphql<T>(key: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await once<T>(key, query, variables);
    } catch (err) {
      const retryable = err instanceof LinearError && err.retryable;
      if (!retryable || attempt >= ATTEMPTS) throw err;
      await new Promise((done) => setTimeout(done, BACKOFF_MS * 2 ** (attempt - 1)));
    }
  }
}

const STATE_TYPES: LinearStateType[] = ["backlog", "unstarted", "started", "completed", "canceled"];

function stateType(raw: string | undefined): LinearStateType {
  return STATE_TYPES.includes(raw as LinearStateType) ? (raw as LinearStateType) : "backlog";
}

function common(raw: RawParent) {
  return {
    id: raw.identifier,
    uuid: raw.id,
    title: raw.title,
    url: raw.url,
    stateName: raw.state?.name ?? "Unknown",
    stateType: stateType(raw.state?.type),
    priority: raw.priority ?? 0,
    projectName: raw.project?.name,
  };
}

// A parent seen only through a child's `parent` field: enough to title and
// status a group header. It carries no attachments or relations of its own.
function toParentStub(raw: RawParent): LinearIssue {
  return { ...common(raw), blockedBy: [], prUrls: [] };
}

function toIssue(raw: RawIssue): LinearIssue {
  return {
    ...common(raw),
    parentId: raw.parent?.identifier,
    // An inverse "blocks" relation means the other issue blocks this one.
    blockedBy: raw.inverseRelations.nodes
      .filter((relation) => relation.type === "blocks" && relation.issue)
      .map((relation) => relation.issue!.identifier),
    prUrls: raw.attachments.nodes.map((a) => a.url).filter((url) => url.includes("/pull/")),
  };
}

export async function validateKey(key: string): Promise<string> {
  const data = await graphql<{ viewer: { name: string } }>(key, "query { viewer { name } }");
  return data.viewer.name;
}

const FIELDS = `
  id identifier title url priority
  state { name type }
  project { name }
`;

const ASSIGNED = `
  query Assigned($after: String, $first: Int!) {
    issues(first: $first, after: $after, filter: { assignee: { isMe: { eq: true } } }, orderBy: updatedAt) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${FIELDS}
        parent { ${FIELDS} }
        attachments(first: 20) { nodes { url } }
        inverseRelations(first: 20) { nodes { type issue { identifier } } }
      }
    }
  }
`;

// Every issue assigned to you, plus a stub for each parent that is not itself
// assigned. The whole assigned set is fetched because Linear's issue filter has
// no operator taking a list of "ACME-1221" identifiers — its `id` filter wants
// UUIDs, which a PR title never carries.
export interface AssignedIssues {
  issues: LinearIssue[];
  /**
   * False when Linear still had pages left at MAX_PAGES. The set is then a
   * prefix of your assigned issues, so a ticket can be missing and its PR can
   * land in the wrong group — which the board has to be able to say.
   */
  complete: boolean;
}

export async function fetchAssignedIssues(key: string): Promise<AssignedIssues> {
  const issues: LinearIssue[] = [];
  const parents = new Map<string, LinearIssue>();
  let after: string | null = null;
  let complete = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawIssue[] } } =
      await graphql(key, ASSIGNED, { after, first: PAGE_SIZE });
    for (const node of data.issues.nodes) {
      issues.push(toIssue(node));
      if (node.parent) parents.set(node.parent.identifier, toParentStub(node.parent));
    }
    if (!data.issues.pageInfo.hasNextPage) {
      complete = true;
      break;
    }
    after = data.issues.pageInfo.endCursor;
  }

  const seen = new Set(issues.map((issue) => issue.id));
  for (const [id, stub] of parents) if (!seen.has(id)) issues.push(stub);

  return { issues, complete };
}

const CHILDREN = `
  query Children($ids: [ID!]) {
    issues(first: 250, filter: { parent: { id: { in: $ids } } }) {
      nodes {
        parent { identifier }
        state { type }
      }
    }
  }
`;

// Counts every sub-ticket of each parent, whoever it is assigned to. The
// assigned-issue fetch cannot answer this: an epic's children include tickets
// assigned to nobody or to someone else, and counting only your own would
// report an epic as further along than it is.
export async function fetchEpicRollups(
  key: string,
  parentUuids: string[],
): Promise<EpicRollup[]> {
  if (parentUuids.length === 0) return [];

  const data = await graphql<{
    issues: { nodes: { parent: { identifier: string } | null; state: RawState | null }[] };
  }>(key, CHILDREN, { ids: parentUuids });

  const byParent = new Map<string, EpicRollup>();
  for (const node of data.issues.nodes) {
    const parent = node.parent?.identifier;
    if (!parent) continue;
    let rollup = byParent.get(parent);
    if (!rollup) {
      rollup = { parentId: parent, done: 0, canceled: 0, started: 0, todo: 0, backlog: 0, live: 0 };
      byParent.set(parent, rollup);
    }
    switch (stateType(node.state?.type)) {
      case "completed":
        rollup.done++;
        break;
      case "canceled":
        rollup.canceled++;
        break;
      case "started":
        rollup.started++;
        break;
      case "unstarted":
        rollup.todo++;
        break;
      default:
        rollup.backlog++;
    }
    if (stateType(node.state?.type) !== "canceled") rollup.live++;
  }

  return [...byParent.values()];
}

/**
 * The ticket half of a refresh, and how much of it to believe. Linear must not
 * be able to fail the refresh — the PR half stands alone — but it must also not
 * be able to silently empty it: with no issues every PR falls out of its epic
 * and into the singles ledger, which looks exactly like a board where nothing
 * is grouped. The previous refresh's issues are kept instead, and the page is
 * told they are old.
 */
export async function fetchTickets(
  key: string | undefined,
  previous: Data | undefined,
): Promise<{ issues: LinearIssue[]; rollups: EpicRollup[]; linear: LinearHealth }> {
  if (!key) return { issues: [], rollups: [], linear: { state: "off" } };

  const why = (err: unknown) => (err instanceof Error ? err.message : "Linear did not answer.");
  const readAt = previous?.linear?.at ?? previous?.at;

  let assigned;
  try {
    assigned = await fetchAssignedIssues(key);
  } catch (err) {
    const issues = previous?.issues ?? [];
    return {
      issues,
      rollups: previous?.rollups ?? [],
      linear: { state: issues.length ? "stale" : "missing", at: readAt, error: why(err) },
    };
  }

  // Progress per parent needs every child, including the ones assigned to
  // nobody, so it is a separate query keyed by the parents actually in play.
  const parentUuids = [
    ...new Set(
      assigned.issues
        .filter((issue) => assigned.issues.some((child) => child.parentId === issue.id))
        .map((issue) => issue.uuid)
        .filter((uuid): uuid is string => Boolean(uuid)),
    ),
  ];

  let rollups: EpicRollup[] = [];
  if (parentUuids.length > 0) {
    try {
      rollups = await fetchEpicRollups(key, parentUuids);
    } catch (err) {
      // The issues themselves arrived, so the grouping stands; what is lost is
      // how far each epic has come — and an epic with one open PR earns its bay
      // from that count alone, so this drops sections, not only spine cells.
      return {
        issues: assigned.issues,
        rollups: previous?.rollups ?? [],
        linear: { state: "stale", at: readAt, error: why(err) },
      };
    }
  }

  return {
    issues: assigned.issues,
    rollups,
    linear: assigned.complete
      ? { state: "ok", at: Date.now() }
      : { state: "partial", at: Date.now(), error: "Linear has more assigned issues than were read." },
  };
}
