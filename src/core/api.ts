import type { CommentAlert, EpicRollup, LinearIssue, PullRequest } from "./types";

// The browser never holds a token. Every call goes to this app's own backend,
// which attaches the credentials it keeps inside the container.

export interface Status {
  githubToken: boolean;
  linearKey: boolean;
  org: string;
  pinned: { githubToken: boolean; linearKey: boolean };
  login: string | null;
  at: number | null;
}

export interface Data {
  prs: PullRequest[];
  issues: LinearIssue[];
  rollups: EpicRollup[];
  at: number;
  login: string;
  /** Comments that arrived during the refresh that built this snapshot. */
  alerts: CommentAlert[];
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status}).`);
  return body as T;
}

export function getStatus(): Promise<Status> {
  return call<Status>("/api/status");
}

export function getData(force = false): Promise<Data> {
  return call<Data>(`/api/data${force ? "?force=1" : ""}`);
}

// The server publishes a timestamp, never data: a token-holding fetch still
// happens only inside the container. EventSource reconnects on its own, so a
// dropped stream costs one missed frame, not the live board.
export function onSync(handler: (at: number) => void): () => void {
  const source = new EventSource("/api/events");
  source.addEventListener("sync", (event) => {
    try {
      const { at } = JSON.parse((event as MessageEvent<string>).data) as { at: number };
      if (typeof at === "number") handler(at);
    } catch {
      // A malformed frame is not worth breaking the stream over.
    }
  });
  return () => source.close();
}

export interface ConfigInput {
  githubToken?: string;
  linearKey?: string;
  org: string;
}

export function saveConfig(input: ConfigInput): Promise<{ ok: true }> {
  return call("/api/config", { method: "POST", body: JSON.stringify(input) });
}

export function sendForReview(nodeId: string): Promise<{ ok: true }> {
  return call("/api/send", { method: "POST", body: JSON.stringify({ nodeId }) });
}

/** Puts a PR back into draft, so a release can be taken back. */
export function undoRelease(nodeId: string): Promise<{ ok: true }> {
  return call("/api/undo", { method: "POST", body: JSON.stringify({ nodeId }) });
}
