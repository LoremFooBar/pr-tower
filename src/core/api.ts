import type { LinearIssue, PullRequest } from "./types";

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
  at: number;
  login: string;
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
