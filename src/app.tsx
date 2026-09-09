import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { toast, Toaster } from "sonner";
import { buildModel } from "@/core/model";
import {
  getData,
  getStatus,
  onSync,
  saveConfig,
  sendForReview,
  undoRelease,
  type ConfigInput,
  type Data,
  type Status,
} from "@/core/api";
import { noticeFor, unseen } from "@/core/notify";
import { nextStages } from "@/core/search";
import { mergedView } from "@/core/merged";
import { timeAgo } from "@/core/store";
import { cn } from "@/lib/utils";
import { stripTicketPrefix } from "@/core/link";
import type { CommentAlert, Item, Stage } from "@/core/types";
import { Setup } from "@/ui/setup";
import { Bay, Ledger, Queue, Stages, STAGE_PROSE, type Handlers } from "@/ui/board";
import { Merged } from "@/ui/merged";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import "@/fonts.css";
import "@/styles.css";
import {
  Bell,
  BellOff,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  Send,
  TowerControl,
  X,
} from "lucide-react";

const UNDO_MS = 10_000;

const NOTICE_TIP: Record<string, string> = {
  live: "A new comment from a person or from Bugbot raises a desktop notification. Muting lasts until you reload.",
  granted: "Muted. Click to hear about new comments again.",
  default: "Notify me when a person or Bugbot comments on one of my PRs.",
  denied: "Your browser is blocking notifications for this page. Allow them in its site settings.",
};

type Permission = NotificationPermission | "unsupported";

function readPermission(): Permission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/**
 * Raises a desktop notification for each comment the server reports as new.
 *
 * The first snapshot a page receives is the baseline, never an announcement: it
 * carries whatever the last refresh found, which on a reload is a conversation
 * the reader has already had. Notifications come from the page rather than a
 * service worker — the app deliberately registers none, and desktop Chromium
 * does not need one to show a notification.
 */
function useArrivals(alerts: CommentAlert[] | undefined, live: boolean) {
  const seen = useRef<Set<string> | null>(null);
  // Read through a ref so muting takes effect without the effect re-running
  // over an unchanged list.
  const on = useRef(live);
  on.current = live;

  useEffect(() => {
    if (!alerts) return;
    if (!seen.current) {
      seen.current = new Set(alerts.map((alert) => alert.id));
      return;
    }

    const fresh = unseen(alerts, seen.current);
    for (const alert of fresh) seen.current.add(alert.id);
    if (!on.current || readPermission() !== "granted") return;

    for (const notice of fresh.map(noticeFor)) {
      const shown = new Notification(notice.title, {
        body: notice.body,
        // Same-origin, which is all the page's own CSP allows.
        icon: "/icon-192.png",
        tag: notice.tag,
      });
      shown.onclick = () => {
        window.focus();
        window.open(notice.url, "_blank", "noopener");
        shown.close();
      };
    }
  }, [alerts]);
}

function prose(stages: Set<Stage>): string {
  const words = [...stages].map((stage) => STAGE_PROSE[stage]);
  if (words.length < 2) return words.join("");
  return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

function useSystemTheme() {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
}

function App() {
  useSystemTheme();

  const [status, setStatus] = useState<Status | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [setupBusy, setSetupBusy] = useState(false);

  const [snapshot, setSnapshot] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const seenAt = useRef(0);
  const [query, setQuery] = useState("");
  const [stages, setStages] = useState<Set<Stage>>(new Set());
  const [searching, setSearching] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const filtering = query.length > 0 || stages.size > 0;

  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState<Set<number>>(new Set());

  // The browser's own permission is the switch that survives a reload; the mute
  // lasts for this page only, because nothing is stored in the browser.
  const [permission, setPermission] = useState<Permission>(readPermission);
  const [muted, setMuted] = useState(false);
  const live = permission === "granted" && !muted;
  useArrivals(snapshot?.alerts, live);

  const model = useMemo(
    () =>
      buildModel(
        snapshot?.prs ?? [],
        snapshot?.issues ?? [],
        snapshot?.rollups ?? [],
        undefined,
        query,
        [...stages],
      ),
    [snapshot, query, stages],
  );

  const mergedShown = useMemo(
    () => mergedView(snapshot?.merged ?? [], query),
    [snapshot, query],
  );

  // A query that matches only a merged PR must not report "Nothing matches":
  // the strip is part of the page the filter searches.
  const nothing = filtering && model.items.length === 0 && mergedShown.length === 0;

  const refresh = useCallback(async (force: boolean) => {
    setLoading(true);
    setError("");
    try {
      setSnapshot(await getData(force));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your PRs.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (snapshot) seenAt.current = snapshot.at;
  }, [snapshot]);

  // The server refreshes on its own; this collects the result. It deliberately
  // does not raise `loading`: the spinner answers for the Sync button, and a
  // board that flickers on a timer nobody pressed reads as a fault.
  useEffect(() => {
    if (!status?.githubToken) return;
    return onSync((at) => {
      if (at <= seenAt.current) return;
      seenAt.current = at;
      getData()
        .then(setSnapshot)
        .catch(() => {});
    });
  }, [status?.githubToken]);

  useEffect(() => {
    getStatus()
      .then((current) => {
        setStatus(current);
        if (current.githubToken) return refresh(false);
        setShowSetup(true);
        setLoading(false);
      })
      .catch(() => {
        setError("The PR Tower backend is not answering.");
        setLoading(false);
      });
  }, [refresh]);

  // A board you scan all day is worth a keystroke: "/" jumps to the filter and
  // Escape empties it, the same pair every list on the web answers to.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        search.current?.focus();
      }
      // Cmd/Ctrl+F opens and closes the filter. This takes the browser's own
      // find-in-page away from this page, which is the point: on a board of
      // rows the app's filter is the one that answers "where is that PR".
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        if (document.activeElement === search.current) {
          setQuery("");
          search.current?.blur();
        } else {
          search.current?.focus();
        }
      }
      if (event.key === "Escape" && target === search.current) {
        setQuery("");
        search.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function connect(input: ConfigInput) {
    setSetupBusy(true);
    setSetupError("");
    try {
      await saveConfig(input);
      setStatus(await getStatus());
      setShowSetup(false);
      refresh(true);
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Those credentials were rejected.");
    } finally {
      setSetupBusy(false);
    }
  }

  function clearFilter() {
    setQuery("");
    setStages(new Set());
  }

  function pickStage(stage: Stage, additive: boolean) {
    setStages((current) => nextStages(current, stage, additive));
  }

  async function toggleNotices() {
    // Chromium grants the prompt only from a gesture, which a click is.
    if (permission === "default") return setPermission(await Notification.requestPermission());
    if (permission === "granted") setMuted((current) => !current);
  }

  function markDraft(ids: Set<number>, draft: boolean) {
    setSnapshot((current) =>
      current
        ? { ...current, prs: current.prs.map((pr) => (ids.has(pr.id) ? { ...pr, draft } : pr)) }
        : current,
    );
  }

  async function release(items: Item[]) {
    setBusy(new Set(items.map((item) => item.pr.id)));
    const sent: Item[] = [];
    const failed: { item: Item; error: string }[] = [];

    for (const item of items) {
      try {
        await sendForReview(item.pr.nodeId);
        sent.push(item);
      } catch (err) {
        failed.push({ item, error: err instanceof Error ? err.message : "Failed." });
      }
    }

    setBusy(new Set());
    setPending(null);
    setPicked(new Set());
    markDraft(new Set(sent.map((item) => item.pr.id)), false);

    for (const failure of failed) {
      toast.error(`${failure.item.pr.repo} #${failure.item.pr.number} stayed a draft`, {
        description: failure.error,
      });
    }

    if (sent.length > 0) {
      toast.success(`Released ${sent.length} ${sent.length === 1 ? "PR" : "PRs"} for review`, {
        description: sent.map((item) => `${item.pr.repo} #${item.pr.number}`).join(", "),
        duration: UNDO_MS,
        action: {
          label: "Undo",
          onClick: async () => {
            const restored: number[] = [];
            for (const item of sent) {
              try {
                await undoRelease(item.pr.nodeId);
                restored.push(item.pr.id);
              } catch {
                // Leave it out for review; the next sync shows the truth.
              }
            }
            markDraft(new Set(restored), true);
            toast(`Back to draft: ${restored.length}`);
          },
        },
      });
    }
  }

  function pick(item: Item) {
    setPicked((current) => {
      const next = new Set(current);
      // Two PRs on one ticket land together, so they select together.
      const together = model.items.filter(
        (other) => item.issue && other.issue?.id === item.issue.id && other.lane === "send",
      );
      const group = together.length > 1 ? together : [item];
      const adding = !next.has(item.pr.id);
      for (const member of group) {
        if (adding) next.add(member.pr.id);
        else next.delete(member.pr.id);
      }
      return next;
    });
  }

  if (showSetup && status) {
    return (
      <TooltipProvider>
        <Setup
          status={status}
          onSave={connect}
          error={setupError}
          busy={setupBusy}
          onCancel={status.githubToken ? () => setShowSetup(false) : undefined}
        />
        <Toaster richColors closeButton />
      </TooltipProvider>
    );
  }

  const chosen = model.queue.filter((item) => picked.has(item.pr.id));
  const handlers: Handlers = { picked, onPick: pick, onRelease: setPending, busy };
  const repos = new Set(model.items.map((item) => item.pr.repo)).size;
  const expanded = searching || query.length > 0;

  return (
    <TooltipProvider delayDuration={300}>
      <header className="bg-background/85 sticky top-0 z-30 border-b backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-6">
          <TowerControl className="text-primary size-5" />
          <span className="font-semibold tracking-tight">PR Tower</span>
          {snapshot ? (
            <span className="text-muted-foreground hidden font-mono text-xs sm:inline">
              {filtering
                ? `${model.counts.shown} of ${model.counts.total}`
                : `${model.counts.total} open`}{" "}
              · {repos} {repos === 1 ? "repo" : "repos"} · synced {timeAgo(snapshot.at)}
            </span>
          ) : null}

          <div className="flex-1" />

          {/* Collapsed it is one glyph, so Sync and Keys keep the right edge
              they have always had. The input is always mounted rather than
              swapped in: focus is what opens it, which is the same path the
              "/" shortcut takes. */}
          <div
            className={cn(
              "relative shrink-0 transition-[width] duration-200 ease-out",
              expanded ? "w-56 lg:w-72" : "w-8",
            )}
            onClick={() => search.current?.focus()}
          >
            <Search
              className={cn(
                "pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 transition-colors",
                expanded ? "text-muted-foreground" : "text-foreground/70",
              )}
            />
            <input
              ref={search}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onFocus={() => setSearching(true)}
              onBlur={() => setSearching(false)}
              placeholder="Filter by title, #number, repo, ticket"
              aria-label="Filter pull requests"
              className={cn(
                "h-8 w-full rounded-md border pl-8 text-sm outline-none transition-[color,background-color,border-color,box-shadow] [&::-webkit-search-cancel-button]:hidden",
                expanded
                  ? "border-input bg-background focus-visible:ring-ring/50 focus-visible:border-ring pr-7 shadow-xs focus-visible:ring-[3px]"
                  : "cursor-pointer border-transparent bg-transparent placeholder:opacity-0",
              )}
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear the filter"
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm p-0.5"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>

          {permission === "unsupported" ? null : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleNotices}
                  aria-label={live ? "Mute comment notifications" : "Notify me about new comments"}
                >
                  {live ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{NOTICE_TIP[live ? "live" : permission]}</TooltipContent>
            </Tooltip>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => refresh(true)}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Sync
          </Button>
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setShowSetup(true)}>
            <KeyRound className="size-3.5" />
            Keys
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-8 px-6 pt-6 pb-32">
        {error ? (
          <div className="border-destructive/50 bg-destructive/5 text-destructive rounded-lg border p-3 text-sm">
            {error}
          </div>
        ) : null}

        {!snapshot && loading ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 py-24 text-sm">
            <Loader2 className="size-4 animate-spin" />
            Loading your pull requests…
          </div>
        ) : null}

        {snapshot && nothing ? (
          <div className="text-muted-foreground space-y-3 py-20 text-center text-sm">
            <p>
              {query ? (
                <>
                  Nothing{stages.size > 0 ? " matching" : " matches"}{" "}
                  <span className="text-foreground font-mono">{query}</span>
                </>
              ) : (
                <>Nothing</>
              )}
              {stages.size > 0 ? ` is ${prose(stages)}` : null}.
            </p>
            <Button variant="outline" size="sm" onClick={clearFilter}>
              Clear the filter
            </Button>
          </div>
        ) : null}

        {snapshot && !nothing ? (
          <>
            {/* While filtering, an empty queue is answering a question nobody
                asked — the filter is about finding a PR, not about what is
                ready. */}
            {!filtering || model.queue.length > 0 ? <Queue model={model} handlers={handlers} /> : null}

            {/* The two ends of the pipeline, read as a pair: what can go out,
                and what went out. The chips below filter neither. */}
            {!query || mergedShown.length > 0 ? (
              <Merged view={mergedShown} days={status?.mergedDays ?? 7} />
            ) : null}

            <Stages
              counts={model.stageCounts}
              picked={stages}
              onPick={pickStage}
              onClear={() => setStages(new Set())}
            />

            {model.bays.length > 0 ? (
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold">By parent task</h2>
                  <Badge variant="secondary" className="font-mono">
                    {model.bays.length}
                  </Badge>
                </div>
                {model.bays.map((group) => (
                  <Bay
                    key={group.key}
                    group={group}
                    // An epic with nothing to act on opens collapsed.
                    defaultOpen={group.lanes.send + group.lanes.held + group.lanes.merge > 0}
                    handlers={handlers}
                  />
                ))}
              </section>
            ) : null}

            <Ledger title="Single tickets" items={model.singles} handlers={handlers} />
            <Ledger title="No linked ticket" items={model.noTicket} handlers={handlers} muted />
          </>
        ) : null}
      </main>

      {chosen.length > 0 ? (
        <div className="fixed inset-x-0 bottom-6 z-40 flex justify-center px-6">
          <div className="bg-popover flex items-center gap-3 rounded-full border py-2 pr-2 pl-5 shadow-lg">
            <span className="text-sm">
              <span className="font-semibold">{chosen.length}</span> selected
            </span>
            <Separator orientation="vertical" className="h-5" />
            <Button variant="ghost" size="sm" onClick={() => setPicked(new Set())}>
              Clear
            </Button>
            <Button size="sm" className="gap-1.5 rounded-full" onClick={() => setPending(chosen)}>
              <Send className="size-3.5" />
              Release {chosen.length}
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog open={pending !== null} onOpenChange={(next) => !next && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Release {pending?.length === 1 ? "this PR" : `these ${pending?.length} PRs`}?
            </DialogTitle>
            <DialogDescription>
              Each comes out of draft, which requests reviewers and notifies them. You can undo for
              ten seconds afterwards, or convert back to draft on GitHub any time.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-64 space-y-2 overflow-y-auto">
            {pending?.map((item) => (
              <div key={item.pr.id} className="flex items-baseline gap-2 text-sm">
                <span className="text-muted-foreground shrink-0 font-mono text-xs">
                  {item.pr.repo} #{item.pr.number}
                </span>
                <span className="truncate">{stripTicketPrefix(item.pr.title)}</span>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={busy.size > 0}>
              Cancel
            </Button>
            <Button
              className="gap-1.5"
              onClick={() => pending && release(pending)}
              disabled={busy.size > 0}
            >
              {busy.size > 0 ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
              Release {pending?.length}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Toaster richColors closeButton position="bottom-center" />
    </TooltipProvider>
  );
}

const root = document.getElementById("app");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
