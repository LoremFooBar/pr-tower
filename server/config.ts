import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export interface Tokens {
  githubToken: string;
  linearKey: string;
  org: string;
  /** How far back the merged strip looks. A setting, not a secret. */
  mergedDays: number;
}

// A window nobody would type on purpose still has to produce a search GitHub
// will accept, so it is clamped rather than trusted.
const MERGED_DAYS_MAX = 90;

// Tokens live only here, in the container. They are never sent to the browser:
// every response that mentions them says whether one is set, not what it is.
const FILE = process.env.PRTOWER_CONFIG ?? "/data/config.json";

const EMPTY: Tokens = { githubToken: "", linearKey: "", org: "", mergedDays: 7 };

function windowDays(value: unknown): number {
  const days = Math.round(Number(value));
  if (!Number.isFinite(days) || days < 1) return EMPTY.mergedDays;
  return Math.min(days, MERGED_DAYS_MAX);
}

let cached: Tokens | null = null;

function fromEnv(): Partial<Tokens> {
  return {
    ...(process.env.GITHUB_TOKEN ? { githubToken: process.env.GITHUB_TOKEN } : {}),
    ...(process.env.LINEAR_KEY ? { linearKey: process.env.LINEAR_KEY } : {}),
    ...(process.env.GITHUB_ORG ? { org: process.env.GITHUB_ORG } : {}),
  };
}

function fromFile(): Partial<Tokens> {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Partial<Tokens>;
  } catch {
    return {};
  }
}

// The environment wins, so a compose file or a secrets manager can pin the
// tokens and the settings screen cannot quietly override them.
export function loadTokens(): Tokens {
  if (!cached) {
    const merged = { ...EMPTY, ...fromFile(), ...fromEnv() };
    cached = { ...merged, mergedDays: windowDays(merged.mergedDays) };
  }
  return cached;
}

function invalidate(): void {
  cached = null;
}

export function envPinned(): { githubToken: boolean; linearKey: boolean } {
  return {
    githubToken: Boolean(process.env.GITHUB_TOKEN),
    linearKey: Boolean(process.env.LINEAR_KEY),
  };
}

// A token supplied through the environment is never written to disk. It was
// deliberately kept out of the volume by whoever set it there, and persisting a
// copy would quietly widen where the secret lives — and would outlive the
// variable that was meant to control it.
export function saveTokens(next: Tokens): Tokens {
  const pinned = envPinned();
  const onDisk = fromFile();
  const merged: Tokens = {
    githubToken: pinned.githubToken ? (onDisk.githubToken ?? "") : next.githubToken,
    linearKey: pinned.linearKey ? (onDisk.linearKey ?? "") : next.linearKey,
    org: next.org,
    mergedDays: windowDays(next.mergedDays),
  };
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(merged, null, 2));
  // Readable only by the container user, so a shared bind mount does not leak
  // the tokens to everything else on the host.
  try {
    chmodSync(FILE, 0o600);
  } catch {
    // Some mounted filesystems reject chmod; the file is still inside the volume.
  }
  invalidate();
  return loadTokens();
}
