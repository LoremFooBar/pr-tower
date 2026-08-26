import type { Gate, Item, LinearIssue } from "../core/types";
import { stripTicketPrefix } from "../core/link";

export function Rail({ gates }: { gates: Gate[] }) {
  const clear = gates.every((gate) => gate.open);
  const title = clear
    ? "All three gates open — clear to send"
    : gates.filter((gate) => !gate.open).map((gate) => `${gate.label}: ${gate.reason}`).join(" · ");
  return (
    <span class={`rail${clear ? " clear" : ""}`} title={title} aria-label={title}>
      {gates.map((gate) => (
        <i key={gate.name} class={gate.open ? "open" : "shut"} />
      ))}
    </span>
  );
}

export function Ticket({ issue, fallback }: { issue?: LinearIssue; fallback?: string }) {
  if (issue) {
    return (
      <a class="ticket" href={issue.url} target="_blank" rel="noreferrer" title={issue.title}>
        {issue.id}
      </a>
    );
  }
  if (fallback) return <span class="ticket">{fallback}</span>;
  return <span class="pill">no ticket</span>;
}

export function State({ issue }: { issue?: LinearIssue }) {
  if (!issue) return null;
  return (
    <span class={`pill pill--${issue.stateType === "started" ? "started" : "state"}`}>
      {issue.stateName}
    </span>
  );
}

const SIGNAL_TONE: Record<string, string> = {
  conflict: "stop",
  red: "stop",
  blocked: "stop",
  no_bot: "hold",
  drift: "hold",
  checks_running: "",
  behind: "",
  idle: "",
  merge: "go",
};

export function Signals({ item, hide }: { item: Item; hide?: string[] }) {
  const shown = hide ? item.signals.filter((signal) => !hide.includes(signal.kind)) : item.signals;
  return (
    <>
      {shown.map((signal) => {
        const tone = SIGNAL_TONE[signal.kind];
        return (
          <span
            key={signal.kind + signal.label}
            class={`pill${tone ? ` pill--${tone}` : ""}`}
            title={signal.detail}
          >
            {signal.label}
          </span>
        );
      })}
    </>
  );
}

interface RowProps {
  item: Item;
  rank?: number;
  selected?: boolean;
  onToggle?: () => void;
  onSend?: () => void;
  sending?: boolean;
  /** Why this row is where it is — the ranking parts, or the shut gate. */
  explain?: "score" | "gate" | "none";
  hideTicket?: boolean;
}

export function Row({
  item,
  rank,
  selected,
  onToggle,
  onSend,
  sending,
  explain = "none",
  hideTicket,
}: RowProps) {
  const { pr, issue, gates } = item;
  const shut = gates.find((gate) => !gate.open);
  const title = issue || hideTicket ? stripTicketPrefix(pr.title) : pr.title;
  // Whatever the row explains in prose below, it does not also repeat as a pill.
  const hide =
    explain === "gate"
      ? ["conflict", "red", "blocked", "checks_running"]
      : explain === "score"
        ? ["idle"]
        : undefined;

  return (
    <div class={`row${item.ready ? " row--clear" : ""}${selected ? " row--selected" : ""}`}>
      {onToggle && (
        <input
          type="checkbox"
          class="check"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${pr.repo} #${pr.number}`}
        />
      )}
      {rank !== undefined && <span class="row-rank">{rank}</span>}
      <Rail gates={gates} />

      <div class="row-body">
        <a class="row-title" href={pr.url} target="_blank" rel="noreferrer">
          {title}
        </a>

        <div class="row-meta">
          <span class="repo">
            <b>{pr.repo}</b> #{pr.number}
          </span>
          {!hideTicket && <Ticket issue={issue} />}
          {!hideTicket && <State issue={issue} />}
          <Signals item={item} hide={hide} />
        </div>

        {explain === "gate" && shut && (
          <p class="row-why">
            <b>{shut.label} gate:</b> {shut.reason}.
          </p>
        )}

        {explain === "score" && (
          <div class="reasons">
            {item.scoreParts.map((part, index) => (
              <span key={part.label} class={`reason${index === 0 ? " reason--lead" : ""}`}>
                {part.label}
              </span>
            ))}
          </div>
        )}
      </div>

      {onSend && (
        <div class="row-side">
          <button class="send-btn" onClick={onSend} disabled={sending || !item.ready}>
            {sending ? "Sending…" : "Send for review"}
          </button>
        </div>
      )}
    </div>
  );
}
