import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { toast, Toaster } from "sonner";
import { buildModel } from "@/core/model";
import {
  getData,
  getStatus,
  saveConfig,
  sendForReview,
  undoRelease,
  type ConfigInput,
  type Data,
  type Status,
} from "@/core/api";
import { timeAgo } from "@/core/store";
import { stripTicketPrefix } from "@/core/link";
import type { Item } from "@/core/types";
import { Setup } from "@/ui/setup";
import { Bay, Ledger, Queue, type Handlers } from "@/ui/board";
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
import { TooltipProvider } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import "@/fonts.css";
import "@/styles.css";
import { KeyRound, Loader2, RefreshCw, Send, TowerControl } from "lucide-react";

const UNDO_MS = 10_000;

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

  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState<Set<number>>(new Set());

  const model = useMemo(
    () => buildModel(snapshot?.prs ?? [], snapshot?.issues ?? [], snapshot?.rollups ?? []),
    [snapshot],
  );

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

  return (
    <TooltipProvider delayDuration={300}>
      <header className="bg-background/85 sticky top-0 z-30 border-b backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-6">
          <TowerControl className="text-primary size-5" />
          <span className="font-semibold tracking-tight">PR Tower</span>
          {snapshot ? (
            <span className="text-muted-foreground hidden font-mono text-xs sm:inline">
              {model.items.length} open · {repos} repos · synced {timeAgo(snapshot.at)}
            </span>
          ) : null}
          <div className="flex-1" />
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

        {snapshot ? (
          <>
            <Queue model={model} handlers={handlers} />

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
