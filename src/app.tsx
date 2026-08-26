import { render } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { buildModel } from "./core/model";
import { fetchMyOpenPRs, sendForReview, validateToken } from "./core/github";
import { fetchAssignedIssues, validateKey } from "./core/linear";
import {
  clearAll,
  EMPTY_CONFIG,
  loadConfig,
  loadSnapshot,
  saveConfig,
  saveSnapshot,
  timeAgo,
  type Config,
  type Snapshot,
} from "./core/store";
import type { Item, LinearIssue, PullRequest } from "./core/types";
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
  const [config, setConfig] = useState<Config>(loadConfig);
  const [showSetup, setShowSetup] = useState(!loadConfig().githubToken);
  const [setupError, setSetupError] = useState("");
  const [setupBusy, setSetupBusy] = useState(false);

  const [snapshot, setSnapshot] = useState<Snapshot | null>(loadSnapshot);
  const [view, setView] = useState<View>("send");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [linearError, setLinearError] = useState("");

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState<Item[] | null>(null);
  const [sending, setSending] = useState(false);
  const [sendingIds, setSendingIds] = useState<Set<number>>(new Set());
  const [results, setResults] = useState<SendResult[] | null>(null);

  const model = useMemo(
    () => buildModel(snapshot?.prs ?? [], snapshot?.issues ?? []),
    [snapshot],
  );

  const refresh = useCallback(
    async (next: Config) => {
      if (!next.githubToken) return;
      setLoading(true);
      setError("");
      setLinearError("");
      setProgress(0);
      try {
        const user = await validateToken(next.githubToken);
        // Linear is fetched alongside but must not be able to fail the refresh:
        // the PR half is still worth showing on its own.
        const issuesPromise: Promise<LinearIssue[]> = next.linearKey
          ? fetchAssignedIssues(next.linearKey).catch((err) => {
              setLinearError(err instanceof Error ? err.message : "Linear failed.");
              return [];
            })
          : Promise.resolve([]);

        const prs: PullRequest[] = await fetchMyOpenPRs(
          next.githubToken,
          user.login,
          next.org,
          (done, total) => setProgress(total ? done / total : 0),
        );
        const issues = await issuesPromise;
        const fresh: Snapshot = { prs, issues, at: Date.now() };
        setSnapshot(fresh);
        saveSnapshot(fresh);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load your PRs.");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (config.githubToken && !showSetup) refresh(config);
    // Runs once on load; later refreshes are explicit.
  }, []);

  async function connect(next: Config) {
    setSetupBusy(true);
    setSetupError("");
    try {
      await validateToken(next.githubToken);
      if (next.linearKey) await validateKey(next.linearKey);
      saveConfig(next);
      setConfig(next);
      setShowSetup(false);
      refresh(next);
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
        await sendForReview(config.githubToken, item.pr.nodeId);
        done.push({ item });
      } catch (err) {
        done.push({ item, error: err instanceof Error ? err.message : "Failed." });
      }
    }
    setResults(done);
    setSending(false);
    setSendingIds(new Set());

    // Reflect the ones that went out without waiting for a full refresh.
    const sent = new Set(done.filter((result) => !result.error).map((result) => result.item.pr.id));
    if (sent.size > 0 && snapshot) {
      const updated: Snapshot = {
        ...snapshot,
        prs: snapshot.prs.map((pr) => (sent.has(pr.id) ? { ...pr, draft: false } : pr)),
      };
      setSnapshot(updated);
      saveSnapshot(updated);
    }
    setSelected(new Set());
  }

  if (showSetup) {
    return (
      <Setup
        initial={config.githubToken ? config : EMPTY_CONFIG}
        onSave={connect}
        error={setupError}
        busy={setupBusy}
        onCancel={config.githubToken ? () => setShowSetup(false) : undefined}
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
            {config.org || "all orgs"}
            {snapshot ? ` · updated ${timeAgo(snapshot.at)}` : ""}
          </span>
          <span class="bar-spacer" />
          {merge.length > 0 && (
            <span class="bar-stat">
              <b>{merge.length}</b> to merge
            </span>
          )}
          <button class="icon-btn" onClick={() => refresh(config)} disabled={loading}>
            {loading ? `Loading ${Math.round(progress * 100)}%` : "Refresh"}
          </button>
          <button class="icon-btn" onClick={() => setShowSetup(true)}>
            Keys
          </button>
        </div>
        {loading && <div class="progress" style={`width:${Math.round(progress * 100)}%`} />}
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
        {linearError && (
          <p class="notice">
            Linear: {linearError} Tickets, priority, and grouping are missing until this is fixed.
          </p>
        )}
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

export { clearAll };
