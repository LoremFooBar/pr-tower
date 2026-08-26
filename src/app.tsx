import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { buildModel } from "./core/model";
import {
  getData,
  getStatus,
  saveConfig,
  sendForReview,
  undoRelease,
  type ConfigInput,
  type Data,
  type Status,
} from "./core/api";
import { timeAgo } from "./core/store";
import { stripTicketPrefix } from "./core/link";
import type { Item } from "./core/types";
import { Setup } from "./ui/setup";
import { Bay, Ledger, Queue } from "./ui/board";
import "./fonts.css";
import "./styles.css";

const COLLAPSED_KEY = "prtower.collapsed";
const UNDO_MS = 10_000;

interface Outcome {
  item: Item;
  error?: string;
}

function readCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function writeCollapsed(keys: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...keys]));
  } catch {
    // A collapsed bay is a convenience; losing it costs nothing.
  }
}

function Confirm({
  items,
  busy,
  outcomes,
  onCancel,
  onConfirm,
}: {
  items: Item[];
  busy: boolean;
  outcomes: Outcome[] | null;
  onCancel(): void;
  onConfirm(): void;
}) {
  const failed = outcomes?.filter((outcome) => outcome.error) ?? [];
  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div class="dialog" role="dialog" aria-modal="true" aria-label="Release for review">
        {!outcomes ? (
          <>
            <h2>Release {items.length === 1 ? "this PR" : `these ${items.length} PRs`}?</h2>
            <p>
              Each comes out of draft, which requests reviewers and notifies them. You can take it
              back for ten seconds afterwards, or convert to draft on GitHub any time.
            </p>
            <ul>
              {items.map((item) => (
                <li key={item.pr.id}>
                  <span class="data">
                    {item.issue?.id ?? "—"} · {item.pr.repo} #{item.pr.number}
                  </span>
                  <span>{stripTicketPrefix(item.pr.title)}</span>
                </li>
              ))}
            </ul>
            <div class="dialog-acts">
              <button class="btn" onClick={onCancel} disabled={busy}>
                cancel
              </button>
              <button class="release" onClick={onConfirm} disabled={busy}>
                {busy ? "releasing…" : `release ${items.length} ▸`}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>
              {failed.length === 0
                ? `Released ${outcomes.length}`
                : `Released ${outcomes.length - failed.length} of ${outcomes.length}`}
            </h2>
            <p>{failed.length === 0 ? "They are out for review." : "The rest are still drafts."}</p>
            <ul>
              {outcomes.map((outcome) => (
                <li key={outcome.item.pr.id}>
                  <span class={outcome.error ? "bad" : "ok"}>{outcome.error ? "failed" : "sent"}</span>
                  <span class="data">
                    {outcome.item.pr.repo} #{outcome.item.pr.number}
                  </span>
                  <span>{outcome.error ?? stripTicketPrefix(outcome.item.pr.title)}</span>
                </li>
              ))}
            </ul>
            <div class="dialog-acts">
              <button class="release" onClick={onCancel}>
                done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [setupBusy, setSetupBusy] = useState(false);

  const [snapshot, setSnapshot] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [undoable, setUndoable] = useState<Item[]>([]);
  const undoTimer = useRef<number | undefined>(undefined);

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

  function markDraft(ids: Set<number>, draft: boolean) {
    setSnapshot((current) =>
      current
        ? { ...current, prs: current.prs.map((pr) => (ids.has(pr.id) ? { ...pr, draft } : pr)) }
        : current,
    );
  }

  async function release(items: Item[]) {
    setBusy(new Set(items.map((item) => item.pr.id)));
    const done: Outcome[] = [];
    for (const item of items) {
      try {
        await sendForReview(item.pr.nodeId);
        done.push({ item });
      } catch (err) {
        done.push({ item, error: err instanceof Error ? err.message : "Failed." });
      }
    }
    setOutcomes(done);
    setBusy(new Set());

    const sent = done.filter((outcome) => !outcome.error).map((outcome) => outcome.item);
    markDraft(new Set(sent.map((item) => item.pr.id)), false);
    setPicked(new Set());

    if (sent.length > 0) {
      setUndoable(sent);
      window.clearTimeout(undoTimer.current);
      undoTimer.current = window.setTimeout(() => setUndoable([]), UNDO_MS);
    }
  }

  async function undo() {
    const items = undoable;
    setUndoable([]);
    window.clearTimeout(undoTimer.current);
    const restored: number[] = [];
    for (const item of items) {
      try {
        await undoRelease(item.pr.nodeId);
        restored.push(item.pr.id);
      } catch {
        // Leave it out for review; the next sync will show the truth.
      }
    }
    markDraft(new Set(restored), true);
  }

  function pick(item: Item) {
    setPicked((current) => {
      const next = new Set(current);
      // Two PRs on one ticket have to land together, so they select together.
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

  function toggleRow(id: number) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleBay(key: string) {
    setTouched((current) => new Set(current).add(key));
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeCollapsed(next);
      return next;
    });
  }

  if (showSetup && status) {
    return (
      <Setup
        status={status}
        onSave={connect}
        error={setupError}
        busy={setupBusy}
        onCancel={status.githubToken ? () => setShowSetup(false) : undefined}
      />
    );
  }

  const chosen = model.queue.filter((item) => picked.has(item.pr.id));
  const handlers = { picked, onPick: pick, onRelease: setPending, busy, open, onToggle: toggleRow };

  return (
    <>
      <header class="head">
        <div class="head-in">
          <span class="mark">PR Tower</span>
          <span class="head-stat">
            {model.items.length} open · {new Set(model.items.map((item) => item.pr.repo)).size} repos
            {snapshot ? ` · synced ${timeAgo(snapshot.at)}` : ""}
          </span>
          <span class="grow" />
          <button class="btn" onClick={() => refresh(true)} disabled={loading}>
            {loading ? "syncing…" : "sync"}
          </button>
          <button class="btn" onClick={() => setShowSetup(true)}>
            keys
          </button>
        </div>
      </header>

      <main class="shell">
        {error ? <p class="notice">{error}</p> : null}
        {!snapshot && loading ? <p class="empty">Loading your pull requests…</p> : null}

        {snapshot ? (
          <>
            <Queue model={model} handlers={handlers} />

            {model.bays.map((group) => {
              // A bay with nothing to act on opens collapsed, until it is opened
              // by hand — after which the choice sticks.
              const idle = group.lanes.send + group.lanes.held + group.lanes.merge === 0;
              const isCollapsed = touched.has(group.key)
                ? collapsed.has(group.key)
                : collapsed.has(group.key) || idle;
              return (
                <Bay
                  key={group.key}
                  group={group}
                  collapsed={isCollapsed}
                  onCollapse={() => toggleBay(group.key)}
                  handlers={handlers}
                />
              );
            })}

            <Ledger title="Singles" items={model.singles} handlers={handlers} eyebrows />
            <Ledger title="No ticket · tooling" items={model.noTicket} handlers={handlers} muted />
          </>
        ) : null}
      </main>

      {chosen.length > 0 && !pending ? (
        <div class="dock">
          <span class="dock-text">
            <b>{chosen.length}</b> selected — releasing notifies reviewers
          </span>
          <button class="btn" onClick={() => setPicked(new Set())}>
            cancel
          </button>
          <button class="release" onClick={() => setPending(chosen)}>
            release {chosen.length} ▸
          </button>
        </div>
      ) : null}

      {undoable.length > 0 && !pending ? (
        <div class="toast">
          <span>
            Released {undoable.length} {undoable.length === 1 ? "PR" : "PRs"}
          </span>
          <button class="toast-undo" onClick={undo}>
            undo (back to draft)
          </button>
        </div>
      ) : null}

      {pending ? (
        <Confirm
          items={pending}
          busy={busy.size > 0}
          outcomes={outcomes}
          onConfirm={() => release(pending)}
          onCancel={() => {
            setPending(null);
            setOutcomes(null);
          }}
        />
      ) : null}
    </>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);
