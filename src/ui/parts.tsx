import type { Item, LinearIssue } from "../core/types";
import { stripTicketPrefix } from "../core/link";

const PRIORITY = ["", "URGENT", "HIGH", "MEDIUM", "LOW"];

export function priorityLabel(issue?: LinearIssue): string {
  return issue ? (PRIORITY[issue.priority] ?? "") : "";
}

export function Spine({ cells }: { cells: Item["lane"] extends never ? never : string[] }) {
  return (
    <span class="spine" aria-hidden="true">
      {cells.map((cell, index) => (
        <i key={index} class={cell} />
      ))}
    </span>
  );
}

/**
 * CI MG BL — solid when the gate is open, amber when it is shut for something
 * you can fix, faint when it is pending or waiting on another ticket. On a PR
 * that is already out for review the column carries review shorthand instead,
 * because gates have stopped being the question.
 */
export function Gates({ item }: { item: Item }) {
  const { pr, gates } = item;

  if (!pr.draft) {
    const changes = pr.changesRequested > 0;
    const botMissing = pr.bugbot === "none" && pr.hasCI;
    return (
      <span class="gates" title={reviewTitle(item)}>
        <span class={pr.approvals > 0 ? "good" : undefined}>✓{pr.approvals}</span>{" "}
        {changes ? <span class="bad">±{pr.changesRequested}</span> : null}
        {!changes ? (
          <span class={botMissing ? "shut" : pr.bugbot === "failure" ? "bad" : "good"}>
            {botMissing ? "bot–" : pr.bugbot === "failure" ? "bot✗" : "bot✓"}
          </span>
        ) : null}
      </span>
    );
  }

  const letters: Record<string, string> = { ci: "CI", merge: "MG", path: "BL" };
  return (
    <span class="gates" title={gates.map((gate) => `${gate.label}: ${gate.reason}`).join(" · ")}>
      {gates.map((gate) => (
        <span
          key={gate.name}
          class={gate.open ? "open" : gate.name === "path" ? "wait" : "shut"}
        >
          {letters[gate.name]}{" "}
        </span>
      ))}
    </span>
  );
}

function reviewTitle(item: Item): string {
  const bits = [`${item.pr.approvals} approval${item.pr.approvals === 1 ? "" : "s"}`];
  if (item.pr.changesRequested > 0) bits.push(`${item.pr.changesRequested} change request`);
  if (item.pr.bugbot === "none" && item.pr.hasCI) bits.push("review bot never ran on this commit");
  return bits.join(" · ");
}

/** The single most useful thing to say about this row's state. */
export function note(item: Item): { text: string; tone: string } {
  const shut = item.gates.find((gate) => !gate.open);
  // The blocking ticket id keeps its capitals; lowercasing it makes it unreadable.
  if (shut && shut.name === "path") return { text: shut.reason.replace(/^Waiting/, "waiting"), tone: "" };
  if (shut) return { text: shut.reason.toLowerCase(), tone: "hold" };
  if (item.lane === "merge") return { text: "approved · mergeable", tone: "steel" };
  if (item.lane === "flight") {
    if (item.pr.changesRequested > 0) return { text: "changes requested", tone: "fault" };
    if (item.pr.bugbot === "none" && item.pr.hasCI) return { text: "in review · bot never ran", tone: "hold" };
    return { text: "in review", tone: "steel" };
  }
  if (item.pr.mergeState === "behind") return { text: "cleared · behind base", tone: "" };
  return { text: "cleared", tone: "" };
}

interface RowProps {
  item: Item;
  /** Shown only on rows that can actually be released. */
  picked?: boolean;
  onPick?(): void;
  onRelease?(): void;
  busy?: boolean;
  /** Bracket glyph for PRs of one ticket that have to land together. */
  bracket?: "top" | "bottom";
  /** Names the parent epic on a ledger row, where there is no bay header. */
  eyebrow?: string;
  expanded?: boolean;
  onToggle?(): void;
}

export function Row({
  item,
  picked,
  onPick,
  onRelease,
  busy,
  bracket,
  eyebrow,
  expanded,
  onToggle,
}: RowProps) {
  const { pr, issue } = item;
  const state = note(item);
  const releasable = item.lane === "send";

  return (
    <div class={`row${bracket ? ` row--pair row--pair-${bracket}` : ""}`} title={bracket ? "Lands together with the other PR on this ticket" : undefined}>
      <span class="row-gutter">
        {onPick && releasable ? (
          <input
            type="checkbox"
            class="pick"
            checked={picked}
            onChange={onPick}
            aria-label={`Select ${pr.repo} #${pr.number}`}
          />
        ) : null}
      </span>

      <Gates item={item} />

      {issue ? (
        <a class="row-ticket" href={issue.url} target="_blank" rel="noreferrer" title={issue.title}>
          {issue.id}
        </a>
      ) : (
        <span class="row-ticket">—</span>
      )}

      <span class="row-repo">
        {pr.repo} <span class="data">#{pr.number}</span>
      </span>

      <a
        class="row-title"
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) return;
          e.preventDefault();
          onToggle?.();
        }}
        title={pr.title}
      >
        {stripTicketPrefix(pr.title)}
      </a>

      <span class={`row-note${state.tone ? ` row-note--${state.tone}` : ""}`}>
        {eyebrow ? <span class="row-eyebrow">↳{eyebrow} </span> : null}
        {state.text}
      </span>

      <span class="row-age">{item.idleDays}d</span>

      <span class="row-act">
        {releasable && onRelease ? (
          <button class="release" onClick={onRelease} disabled={busy}>
            {busy ? "sending" : "release ▸"}
          </button>
        ) : null}
      </span>

      {expanded ? (
        <span class="detail">
          {item.scoreParts.map((part) => (
            <span key={part.label}>
              {part.label.toLowerCase()} +{part.points}
            </span>
          ))}
          <span>score {item.score}</span>
          {pr.additions !== undefined ? (
            <span>
              +{pr.additions} −{pr.deletions} · {pr.changedFiles} files
            </span>
          ) : null}
          {pr.headRef ? <span>{pr.headRef}</span> : null}
          <a href={pr.url} target="_blank" rel="noreferrer">
            github ↗
          </a>
          {issue ? (
            <a href={issue.url} target="_blank" rel="noreferrer">
              linear ↗
            </a>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
