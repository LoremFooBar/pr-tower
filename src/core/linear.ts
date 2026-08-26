import type { LinearIssue, LinearStateType } from "./types";

const API = "https://api.linear.app/graphql";
const PAGE_SIZE = 100;
const MAX_PAGES = 6;

export class LinearError extends Error {}

interface RawState {
  name: string;
  type: string;
}

interface RawParent {
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

async function graphql<T>(key: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(API, {
    method: "POST",
    // A personal API key goes in Authorization raw. "Bearer" is for OAuth
    // access tokens only, and Linear rejects it here.
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new LinearError(res.status === 400 || res.status === 401 ? "Key rejected." : `Linear returned ${res.status}.`);
  }
  const body = await res.json();
  if (body.errors?.length) throw new LinearError(body.errors[0].message);
  if (!body.data) throw new LinearError("Linear returned no data.");
  return body.data as T;
}

const STATE_TYPES: LinearStateType[] = ["backlog", "unstarted", "started", "completed", "canceled"];

function stateType(raw: string | undefined): LinearStateType {
  return STATE_TYPES.includes(raw as LinearStateType) ? (raw as LinearStateType) : "backlog";
}

function common(raw: RawParent) {
  return {
    id: raw.identifier,
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
  identifier title url priority
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
export async function fetchAssignedIssues(key: string): Promise<LinearIssue[]> {
  const issues: LinearIssue[] = [];
  const parents = new Map<string, LinearIssue>();
  let after: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawIssue[] } } =
      await graphql(key, ASSIGNED, { after, first: PAGE_SIZE });
    for (const node of data.issues.nodes) {
      issues.push(toIssue(node));
      if (node.parent) parents.set(node.parent.identifier, toParentStub(node.parent));
    }
    if (!data.issues.pageInfo.hasNextPage) break;
    after = data.issues.pageInfo.endCursor;
  }

  const seen = new Set(issues.map((issue) => issue.id));
  for (const [id, stub] of parents) if (!seen.has(id)) issues.push(stub);

  return issues;
}
