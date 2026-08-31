import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { convertToDraft, fetchMyOpenPRs, sendForReview, validateToken } from "./github";
import { fetchAssignedIssues, fetchEpicRollups, validateKey } from "./linear";
import { envPinned, loadTokens, saveTokens } from "./config";
import type { EpicRollup, LinearIssue, PullRequest } from "../src/core/types";

const PORT = Number(process.env.PORT ?? 5178);
const here = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(here, "index.html");
const SNAPSHOT = process.env.PRTOWER_SNAPSHOT ?? "/data/snapshot.json";

// The page still carries everything it renders. These are the only files a
// browser must fetch separately, and it fetches them to offer the app for
// install: a manifest cannot be inlined, and manifest icons cannot be data URIs.
// The paths are keys of this map, never taken from the request, so there is
// nothing to traverse with.
const INSTALL_FILES: Record<string, string> = {
  "/manifest.webmanifest": "application/manifest+json",
  "/icon-192.png": "image/png",
  "/icon-512.png": "image/png",
  "/icon-maskable-512.png": "image/png",
};

// A refresh costs four GitHub calls per PR, plus a fifth for a PR sharing its
// repository with another, so repeat loads serve the last one unless it is older
// than this or the client asks for a forced refresh.
const FRESH_MS = 15 * 60 * 1000;

// The server refreshes on its own at this interval, so an open board is never
// more than this stale. It is the app's standing API cost with nobody watching.
const AUTO_MS = 5 * 60 * 1000;

// Long enough to be cheap, short enough that a stream dropped by a sleeping
// laptop surfaces as an error the browser can reconnect from.
const BEAT_MS = 25 * 1000;

interface Snapshot {
  prs: PullRequest[];
  issues: LinearIssue[];
  rollups: EpicRollup[];
  at: number;
  login: string;
}

let snapshot: Snapshot | null = readSnapshot();
let inFlight: Promise<Snapshot> | null = null;
const listeners = new Set<ServerResponse>();

// The frame carries the timestamp and nothing else, so the fetch that holds a
// token stays behind /api/data and inside the container.
function announce(at: number): void {
  const frame = `event: sync\ndata: ${JSON.stringify({ at })}\n\n`;
  for (const res of listeners) res.write(frame);
}

function readSnapshot(): Snapshot | null {
  try {
    return JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

function writeSnapshot(next: Snapshot): void {
  try {
    writeFileSync(SNAPSHOT, JSON.stringify(next));
  } catch {
    // A read-only volume only costs the warm start.
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

// The API has no login of its own, so anything reachable from a browser could be
// driven by any page you happen to be visiting. Two checks close that:
// a cross-origin request is refused outright, and a mutating request must be
// JSON, which forces a preflight the origin check then fails.
function crossOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  const host = req.headers.host ?? "";
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

function refresh(force: boolean): Promise<Snapshot> {
  if (inFlight) return inFlight;
  if (!force && snapshot && Date.now() - snapshot.at < FRESH_MS) {
    return Promise.resolve(snapshot);
  }

  inFlight = (async () => {
    const tokens = loadTokens();
    if (!tokens.githubToken) throw new Error("No GitHub token is configured.");
    const user = await validateToken(tokens.githubToken);

    // Linear must not be able to fail the refresh; the PR half stands alone.
    const issues = tokens.linearKey
      ? await fetchAssignedIssues(tokens.linearKey).catch(() => [] as LinearIssue[])
      : [];

    // Progress per parent needs every child, including the ones assigned to
    // nobody, so it is a separate query keyed by the parents actually in play.
    const parentUuids = [
      ...new Set(
        issues
          .filter((issue) => issues.some((child) => child.parentId === issue.id))
          .map((issue) => issue.uuid)
          .filter((uuid): uuid is string => Boolean(uuid)),
      ),
    ];
    const rollups =
      tokens.linearKey && parentUuids.length > 0
        ? await fetchEpicRollups(tokens.linearKey, parentUuids).catch(() => [] as EpicRollup[])
        : [];

    const prs = await fetchMyOpenPRs(tokens.githubToken, user.login, tokens.org);

    const next: Snapshot = { prs, issues, rollups, at: Date.now(), login: user.login };
    snapshot = next;
    writeSnapshot(next);
    announce(next.at);
    return next;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

const routes: Record<string, (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>> = {
  async "GET /api/status"(_req, res) {
    const tokens = loadTokens();
    const pinned = envPinned();
    // Whether a token exists, never what it is.
    send(res, 200, {
      githubToken: Boolean(tokens.githubToken),
      linearKey: Boolean(tokens.linearKey),
      org: tokens.org,
      pinned,
      login: snapshot?.login ?? null,
      at: snapshot?.at ?? null,
    });
  },

  async "POST /api/config"(req, res) {
    const body = (await readJson(req)) as Partial<Record<string, string>>;
    const current = loadTokens();
    const pinned = envPinned();
    const githubToken = pinned.githubToken
      ? current.githubToken
      : (body.githubToken?.trim() || current.githubToken);
    const linearKey = pinned.linearKey
      ? current.linearKey
      : body.linearKey === ""
        ? ""
        : (body.linearKey?.trim() || current.linearKey);

    if (!githubToken) return send(res, 400, { error: "A GitHub token is required." });

    try {
      await validateToken(githubToken);
      if (linearKey) await validateKey(linearKey);
    } catch (err) {
      return send(res, 400, { error: err instanceof Error ? err.message : "Rejected." });
    }

    saveTokens({ githubToken, linearKey, org: (body.org ?? current.org).trim() });
    snapshot = null;
    send(res, 200, { ok: true });
  },

  async "GET /api/data"(_req, res, url) {
    try {
      const data = await refresh(url.searchParams.get("force") === "1");
      send(res, 200, {
        prs: data.prs,
        issues: data.issues,
        rollups: data.rollups,
        at: data.at,
        login: data.login,
      });
    } catch (err) {
      send(res, 502, { error: err instanceof Error ? err.message : "Refresh failed." });
    }
  },

  async "GET /api/events"(req, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // Node holds the headers back until the first write, and a subscriber that
    // has not seen them yet cannot know the stream is open.
    res.write(": open\n\n");
    listeners.add(res);
    const beat = setInterval(() => res.write(": beat\n\n"), BEAT_MS);
    req.on("close", () => {
      clearInterval(beat);
      listeners.delete(res);
    });
  },

  async "POST /api/send"(req, res) {
    await flipDraft(req, res, false);
  },

  async "POST /api/undo"(req, res) {
    await flipDraft(req, res, true);
  },
};

// Both writes are the same shape: change one PR's draft flag at GitHub, then
// mirror it in the snapshot so the board is right before the next refresh.
async function flipDraft(req: IncomingMessage, res: ServerResponse, toDraft: boolean): Promise<void> {
  const body = (await readJson(req)) as { nodeId?: string };
  if (!body.nodeId) return send(res, 400, { error: "nodeId is required." });
  const tokens = loadTokens();
  if (!tokens.githubToken) return send(res, 400, { error: "No GitHub token is configured." });
  try {
    if (toDraft) await convertToDraft(tokens.githubToken, body.nodeId);
    else await sendForReview(tokens.githubToken, body.nodeId);
    if (snapshot) {
      snapshot = {
        ...snapshot,
        prs: snapshot.prs.map((pr) => (pr.nodeId === body.nodeId ? { ...pr, draft: toDraft } : pr)),
      };
      writeSnapshot(snapshot);
    }
    send(res, 200, { ok: true });
  } catch (err) {
    send(res, 502, { error: err instanceof Error ? err.message : "The write failed." });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (crossOrigin(req)) {
    return send(res, 403, { error: "Cross-origin requests are refused." });
  }

  const route = routes[`${req.method} ${url.pathname}`];
  if (route) {
    if (req.method === "POST" && !(req.headers["content-type"] ?? "").includes("application/json")) {
      return send(res, 415, { error: "Send JSON." });
    }
    try {
      await route(req, res, url);
    } catch (err) {
      send(res, 500, { error: err instanceof Error ? err.message : "Server error." });
    }
    return;
  }

  if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "No such endpoint." });

  const installType = INSTALL_FILES[url.pathname];
  if (installType) {
    try {
      const body = readFileSync(resolve(here, url.pathname.slice(1)));
      res.writeHead(200, { "content-type": installType, "cache-control": "no-store" });
      return res.end(body);
    } catch {
      return send(res, 404, { error: "That file is not in the image." });
    }
  }

  // Everything else is the app: one self-contained HTML file.
  try {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // The page loads nothing from anywhere, and talks only to its own origin.
      // manifest-src and the 'self' in img-src are the whole cost of being
      // installable: the manifest and its icons are same-origin files rather
      // than data URIs. Nothing external is reachable from either.
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    res.end(readFileSync(INDEX));
  } catch {
    res.writeHead(500).end("The app bundle is missing. Rebuild the image.");
  }
});

// A failed automatic refresh keeps the last snapshot and says nothing: nobody
// asked for this one, and the next attempt is five minutes away.
const auto = setInterval(() => {
  if (!loadTokens().githubToken) return;
  refresh(true).catch(() => {});
}, AUTO_MS);
auto.unref();

server.listen(PORT, () => {
  console.log(`PR Tower on http://localhost:${PORT}`);
});
