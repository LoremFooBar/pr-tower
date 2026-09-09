import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  convertToDraft,
  fetchMyOpenPRs,
  fetchNewComments,
  fetchRecentlyMerged,
  groupComments,
  sendForReview,
  validateToken,
} from "./github";
import { fetchAssignedIssues, fetchEpicRollups, validateKey } from "./linear";
import { envPinned, loadTokens, saveTokens } from "./config";
import type { CommentAlert, Data, EpicRollup, LinearIssue } from "../src/core/types";
import type { SettledDeploy } from "./github";

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

// How many comment keys are carried between refreshes to stop an announcement
// repeating. A sweep asks GitHub for `since` the last one, so the window that
// can come back twice is minutes wide; this is generous for that.
const SEEN_CAP = 400;

/**
 * What the server remembers between refreshes and never sends anywhere. Keeping
 * it beside the payload rather than inside it is what makes `/api/data` safe by
 * construction: the response is one object, so a private field cannot reach the
 * browser by being forgotten in a list.
 */
interface Cursors {
  /**
   * The instant the last comment sweep started, and the cursor for the next one.
   * Absent until a first refresh has run: a board opened for the first time must
   * not announce every comment already on the PRs.
   */
  commentsSince?: string;
  /** Comment keys already announced. */
  commentsSeen?: string[];
  /**
   * Deploy results that can no longer change, keyed by PR. Only a
   * green one is kept: a red deploy gets re-run from the GitHub UI, and the
   * strip has to turn green when someone does that.
   */
  deploysSettled?: Record<string, SettledDeploy>;
}

interface Snapshot {
  public: Data;
  cursors: Cursors;
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
    const saved = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;
    // A file written before the split has no `public`. It is only a warm start,
    // so the next refresh rebuilds it rather than the reader guessing a shape.
    return saved?.public ? saved : null;
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
  if (!force && snapshot && Date.now() - snapshot.public.at < FRESH_MS) {
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

    const { prs, notes } = await fetchMyOpenPRs(tokens.githubToken, user.login, tokens.org);

    // Started before the sweep, so a comment posted while it runs is newer than
    // the cursor and is caught by the next one rather than falling in the gap.
    const sweptAt = new Date().toISOString();
    const since = snapshot?.cursors.commentsSince;
    const seen = new Set(snapshot?.cursors.commentsSeen ?? []);

    // A comment sweep must not be able to fail the refresh, and on the very
    // first one there is no cursor to sweep from — only a baseline to set.
    const swept = since
      ? await fetchNewComments(tokens.githubToken, prs, since).catch(() => [])
      : [];
    const { alerts, keys } = since
      ? groupComments([...swept, ...notes], prs, user.login, since, seen)
      : { alerts: [] as CommentAlert[], keys: [] as string[] };

    // Merged PRs must not fail the refresh either, and they are the one source
    // that reads its own previous answers: a PR that is fully live is never
    // asked about again.
    const frozen = snapshot?.cursors.deploysSettled ?? {};
    const shipped = await fetchRecentlyMerged(
      tokens.githubToken,
      user.login,
      tokens.org,
      tokens.mergedDays,
      frozen,
    ).catch(() => ({ merged: [] as Data["merged"], settled: frozen }));

    const next: Snapshot = {
      public: {
        prs,
        issues,
        rollups,
        alerts,
        merged: shipped.merged,
        at: Date.now(),
        login: user.login,
      },
      cursors: {
        commentsSince: sweptAt,
        commentsSeen: [...new Set([...seen, ...keys])].slice(-SEEN_CAP),
        deploysSettled: shipped.settled,
      },
    };
    snapshot = next;
    writeSnapshot(next);
    announce(next.public.at);
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
      login: snapshot?.public.login ?? null,
      at: snapshot?.public.at ?? null,
      mergedDays: tokens.mergedDays,
    });
  },

  async "POST /api/config"(req, res) {
    const body = (await readJson(req)) as Partial<Record<string, string | number>>;
    const current = loadTokens();
    const pinned = envPinned();
    const typed = (value: unknown) => (typeof value === "string" ? value.trim() : undefined);
    const githubToken = pinned.githubToken
      ? current.githubToken
      : (typed(body.githubToken) || current.githubToken);
    const linearKey = pinned.linearKey
      ? current.linearKey
      : body.linearKey === ""
        ? ""
        : (typed(body.linearKey) || current.linearKey);

    if (!githubToken) return send(res, 400, { error: "A GitHub token is required." });

    try {
      await validateToken(githubToken);
      if (linearKey) await validateKey(linearKey);
    } catch (err) {
      return send(res, 400, { error: err instanceof Error ? err.message : "Rejected." });
    }

    saveTokens({
      githubToken,
      linearKey,
      org: typed(body.org) ?? current.org,
      mergedDays: Number(body.mergedDays ?? current.mergedDays),
    });
    snapshot = null;
    send(res, 200, { ok: true });
  },

  async "GET /api/data"(_req, res, url) {
    try {
      const data = await refresh(url.searchParams.get("force") === "1");
      send(res, 200, data.public);
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
        public: {
          ...snapshot.public,
          prs: snapshot.public.prs.map((pr) =>
            pr.nodeId === body.nodeId ? { ...pr, draft: toDraft } : pr,
          ),
        },
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
