import type { LinearIssue, PullRequest } from "./types";

export interface Config {
  githubToken: string;
  linearKey: string;
  org: string;
}

export const EMPTY_CONFIG: Config = { githubToken: "", linearKey: "", org: "acme" };

const CONFIG_KEY = "prtower.config";
const CACHE_KEY = "prtower.cache";

// Every read is guarded: a file:// page in a private window can throw on
// localStorage access rather than returning null.
function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable or full; the app still works for this session.
  }
}

export function loadConfig(): Config {
  return { ...EMPTY_CONFIG, ...(read<Partial<Config>>(CONFIG_KEY) ?? {}) };
}

export function saveConfig(config: Config): void {
  write(CONFIG_KEY, config);
}

export function clearAll(): void {
  try {
    localStorage.removeItem(CONFIG_KEY);
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // Nothing to clear.
  }
}

export interface Snapshot {
  prs: PullRequest[];
  issues: LinearIssue[];
  at: number;
}

export function loadSnapshot(): Snapshot | null {
  const snapshot = read<Snapshot>(CACHE_KEY);
  return snapshot?.prs ? snapshot : null;
}

export function saveSnapshot(snapshot: Snapshot): void {
  write(CACHE_KEY, snapshot);
}

export function timeAgo(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
