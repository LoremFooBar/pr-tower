import { render } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { buildModel } from "./core/model";
import {
  getData,
  getStatus,
  saveConfig,
  sendForReview,
  type ConfigInput,
  type Data,
  type Status,
} from "./core/api";
import { timeAgo } from "./core/store";
import type { Item } from "./core/types";
import { Setup } from "./ui/setup";
import { Flight, Held, Queue, Tree } from "./ui/views";
import { stripTicketPrefix } from "./core/link";
import "./fonts.css";
import "./styles.css";

type View = "send" | "held" | "flight" | "tree";

interface SendResult {
  item: Item;
  error?: string;
}

function Wordmark() {
  return (
    <span class="wordmark">
      <span class="wordmark-rail">
        <i />
        <i />
        <i />
      </span>
      PR Tower
    </span>
  );
}

function ConfirmSend({
  items,
  onCancel,
  onConfirm,
  busy,
  results,
}: {
  items: Item[];
  onCancel(): void;
  onConfirm(): void;
  busy: boolean;
  results: SendResult[] | null;
}) {
  const done = results !== null;
  const failed = results?.filter((result) => result.error) ?? [];

  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div class="dialog" role="dialog" aria-modal="true" aria-label="Send for review">
        {!done ? (
          <>
            <h2>Send {items.length === 1 ? "this PR" : `these ${items.length} PRs`} for review?</h2>
            <p>
              Each one comes out of draft. Reviewers are requested automatically, so this
              notifies people. You can put a PR back into draft on GitHub if you change your mind.
            </p>
            <ul>
              {items.map((item) => (
                <li key={item.pr.id}>
                  <span class="repo">
                    <b>{item.pr.repo}</b> #{item.pr.number}
                  </span>
                  <span>{stripTicketPrefix(item.pr.title)}</span>
                </li>
              ))}
            </ul>
            <div class="dialog-actions">
              <button class="ghost-btn" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
              <button class="send-btn" onClick={onConfirm} disabled={busy}>
                {busy ? "Sending…" : `Send ${items.length}`}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>
              {failed.length === 0
                ? `Sent ${results.length === 1 ? "1 PR" : `${results.length} PRs`}`
                : `Sent ${results.length - failed.length} of ${results.length}`}
            </h2>
            <p>
              {failed.length === 0
                ? "They are out for review now."
                : "The rest are still drafts. The reason for each failure is below."}
            </p>
            <ul>
              {results.map((result) => (
                <li key={result.item.pr.id}>
                  <span class={result.error ? "result-bad" : "result-ok"}>
                    {result.error ? "failed" : "sent"}
                  </span>
                  <span class="repo">
                    <b>{result.item.pr.repo}</b> #{result.item.pr.number}
                  </span>
                  <span>{result.error ?? stripTicketPrefix(result.item.pr.title)}</span>
                </li>
              ))}
            </ul>
            <div class="dialog-actions">
              <button class="send-btn" onClick={onCancel}>
                Done
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
  const [view, setView] = useState<View>("send");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState<Item[] | null>(null);
  const [sending, setSending] = useState(false);
  const [sendingIds, setSendingIds] = useState<Set<number>>(new Set());
  const [results, setResults] = useState<SendResult[] | null>(null);

  const model = useMemo(
    () => buildModel(snapshot?.prs ?? [], snapshot?.issues ?? []),
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

  const queue = model.queue;
  const held = model.items.filter((item) => item.lane === "held");
  const flight = model.items.filter((item) => item.lane === "flight");
  const merge = model.items.filter((item) => item.lane === "merge");

  const chosen = queue.filter((item) => selected.has(item.pr.id));

  function toggle(id: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function doSend(items: Item[]) {
    setSending(true);
    setSendingIds(new Set(items.map((item) => item.pr.id)));
    const done: SendResult[] = [];
    for (const item of items) {
      try {
        await sendForReview(item.pr.nodeId);
        done.push({ item });
      } catch (err) {
        done.push({ item, error: err instanceof Error ? err.message : "Failed." });
      }
    }
    setResults(done);
    setSending(false);
    setSendingIds(new Set());

    // Reflect the ones that went out without waiting for a full refresh. The
    // server does the same to its own snapshot.
    const sent = new Set(done.filter((result) => !result.error).map((result) => result.item.pr.id));
    if (sent.size > 0 && snapshot) {
      setSnapshot({
        ...snapshot,
        prs: snapshot.prs.map((pr) => (sent.has(pr.id) ? { ...pr, draft: false } : pr)),
      });
    }
    setSelected(new Set());
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

  const tabs: { key: View; label: string; count: number; live?: boolean }[] = [
    { key: "send", label: "Ready to send", count: queue.length, live: queue.length > 0 },
    { key: "held", label: "Held back", count: held.length },
    { key: "flight", label: "Out for review", count: flight.length + merge.length },
    { key: "tree", label: "Everything", count: model.items.length },
  ];

  return (
    <>
      <header class="bar">
        <div class="bar-inner">
          <Wordmark />
          <span class="bar-scope">
            {status?.org || "all orgs"}
            {snapshot ? ` · updated ${timeAgo(snapshot.at)}` : ""}
          </span>
          <span class="bar-spacer" />
          {merge.length > 0 && (
            <span class="bar-stat">
              <b>{merge.length}</b> to merge
            </span>
          )}
          <button class="icon-btn" onClick={() => refresh(true)} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button class="icon-btn" onClick={() => setShowSetup(true)}>
            Keys
          </button>
        </div>

      </header>

      <nav class="lanes">
        <div class="lanes-inner" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={view === tab.key}
              class={`lane-tab lane-tab--${tab.key}`}
              onClick={() => setView(tab.key)}
            >
              {tab.label}
              <span class={`lane-n${tab.live ? " lane-n--live" : ""}`}>{tab.count}</span>
            </button>
          ))}
        </div>
      </nav>

      <main class="page">
        {error && <p class="notice">{error}</p>}
        {!snapshot && loading && <div class="empty">Loading your pull requests…</div>}

        {view === "send" && (
          <Queue
            items={queue}
            selected={selected}
            onToggle={toggle}
            onSend={(item) => setPending([item])}
            sendingIds={sendingIds}
          />
        )}
        {view === "held" && <Held items={held} />}
        {view === "flight" && <Flight items={flight} merge={merge} />}
        {view === "tree" && <Tree model={model} />}
      </main>

      {chosen.length > 0 && view === "send" && !pending && (
        <div class="dock">
          <span class="dock-text">
            <b>{chosen.length}</b> selected
          </span>
          <button class="ghost-btn" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <button class="send-btn" onClick={() => setPending(chosen)}>
            Send {chosen.length} for review
          </button>
        </div>
      )}

      {pending && (
        <ConfirmSend
          items={pending}
          busy={sending}
          results={results}
          onConfirm={() => doSend(pending)}
          onCancel={() => {
            setPending(null);
            setResults(null);
          }}
        />
      )}
    </>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);
