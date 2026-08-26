import type { Group, Item } from "../core/types";
import type { Model } from "../core/model";
import { stripTicketPrefix } from "../core/link";
import { priorityLabel, Row, Spine } from "./parts";

interface Handlers {
  picked: Set<number>;
  onPick(item: Item): void;
  onRelease(items: Item[]): void;
  busy: Set<number>;
  open: Set<number>;
  onToggle(id: number): void;
}

/** PRs of one ticket that have to land together are joined in the gutter. */
function bracketFor(items: Item[], index: number): "top" | "bottom" | undefined {
  if (items.length < 2) return undefined;
  if (index === 0) return "top";
  if (index === items.length - 1) return "bottom";
  return undefined;
}

function rowsOf(group: Group): { item: Item; bracket?: "top" | "bottom" }[] {
  return group.tickets.flatMap((ticket) =>
    ticket.items.map((item, index) => ({ item, bracket: bracketFor(ticket.items, index) })),
  );
}

function Rows({ rows, handlers }: { rows: { item: Item; bracket?: "top" | "bottom" }[]; handlers: Handlers }) {
  return (
    <div class="rows">
      {rows.map(({ item, bracket }) => (
        <Row
          key={item.pr.id}
          item={item}
          bracket={bracket}
          picked={handlers.picked.has(item.pr.id)}
          onPick={() => handlers.onPick(item)}
          onRelease={() => handlers.onRelease([item])}
          busy={handlers.busy.has(item.pr.id)}
          expanded={handlers.open.has(item.pr.id)}
          onToggle={() => handlers.onToggle(item.pr.id)}
        />
      ))}
    </div>
  );
}

export function Queue({
  model,
  handlers,
}: {
  model: Model;
  handlers: Handlers;
}) {
  const cleared = model.queue;

  return (
    <section class="queue">
      <div class="queue-head">
        <span class="queue-title">
          Cleared — {cleared.length === 0 ? "nothing ready" : `${cleared.length} ready to release`}
        </span>
        <span class="grow" />
        {cleared.length > 1 ? (
          <button class="release release--ghost" onClick={() => handlers.onRelease(cleared)}>
            release all {cleared.length} ▸
          </button>
        ) : null}
      </div>

      {cleared.length === 0 ? (
        <p class="queue-empty">
          {model.closest ? (
            <>
              Nothing is cleared. Closest:{" "}
              <b>{model.closest.issue?.id ?? `${model.closest.pr.repo} #${model.closest.pr.number}`}</b>{" "}
              — {(model.closest.gates.find((gate) => !gate.open)?.reason ?? "").toLowerCase()}.
            </>
          ) : (
            <>Nothing is cleared, and no draft is close.</>
          )}
        </p>
      ) : (
        <div class="queue-cards">
          {cleared.map((item) => (
            <div key={item.pr.id} class={`card${handlers.picked.has(item.pr.id) ? " card--picked" : ""}`}>
              <div class="card-top">
                <input
                  type="checkbox"
                  class="pick"
                  checked={handlers.picked.has(item.pr.id)}
                  onChange={() => handlers.onPick(item)}
                  aria-label={`Select ${item.pr.repo} #${item.pr.number}`}
                />
                <a class="card-title" href={item.pr.url} target="_blank" rel="noreferrer">
                  {stripTicketPrefix(item.pr.title)}
                </a>
              </div>
              <span class="card-meta">
                {item.issue?.id ? `${item.issue.id} · ` : ""}
                {item.pr.repo} #{item.pr.number}
                {item.pr.additions !== undefined ? ` · +${item.pr.additions} −${item.pr.deletions}` : ""}
              </span>
              <span class="card-why">
                score {item.score} ·{" "}
                {item.scoreParts
                  .filter((part) => !part.label.startsWith("Idle"))
                  .map((part) => part.label.toLowerCase())
                  .join(" · ")}
              </span>
              <div class="card-foot">
                <span class="card-meta">idle {item.idleDays}d</span>
                <button
                  class="release"
                  onClick={() => handlers.onRelease([item])}
                  disabled={handlers.busy.has(item.pr.id)}
                >
                  {handlers.busy.has(item.pr.id) ? "sending" : "release ▸"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function Bay({
  group,
  collapsed,
  onCollapse,
  handlers,
}: {
  group: Group;
  collapsed: boolean;
  onCollapse(): void;
  handlers: Handlers;
}) {
  const rows = rowsOf(group);
  const cleared = rows.filter(({ item }) => item.lane === "send").map(({ item }) => item);
  const priority = priorityLabel(group.epic);

  const blocked = rows.filter(({ item }) =>
    item.signals.some((signal) => signal.kind === "blocked"),
  ).length;
  const counts = [
    group.rollup ? `${group.rollup.done} done` : null,
    group.lanes.merge ? `${group.lanes.merge} to merge` : null,
    group.lanes.send ? `${group.lanes.send} cleared` : null,
    group.lanes.held - blocked > 0 ? `${group.lanes.held - blocked} need you` : null,
    group.lanes.flight ? `${group.lanes.flight} waiting` : null,
    blocked ? `${blocked} blocked` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section class="bay">
      <div
        class="bay-head"
        onClick={onCollapse}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onCollapse();
          }
        }}
      >
        <div class="bay-line1">
          <span class="bay-caret">{collapsed ? "▸" : "▾"}</span>
          {group.epic ? (
            <a
              class="bay-key"
              href={group.epic.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              {group.epic.id}
            </a>
          ) : (
            <span class="bay-key">—</span>
          )}
          <span class="bay-name" title={group.title}>
            {group.title}
          </span>
          <span class="bay-tags">
            {priority ? <span class={priority === "URGENT" ? "urgent" : undefined}>{priority}</span> : null}
            {priority && group.epic ? " · " : ""}
            {group.epic?.stateName.toUpperCase()}
          </span>
        </div>
        <div class="bay-line2">
          <Spine cells={group.spine} />
          <span class="bay-counts">
            {counts}
            {group.repos > 1 ? ` · ${group.repos} repos` : ""}
          </span>
          <span class={`bay-move bay-move--${group.move.kind}`}>
            {group.move.kind === "waiting" ? group.move.text : `next → ${group.move.text}`}
          </span>
        </div>
      </div>

      {!collapsed ? (
        <>
          {cleared.length > 1 ? (
            <div class="queue-head" style="margin:6px 0 0;justify-content:flex-end">
              <span class="grow" />
              <button class="release release--ghost" onClick={() => handlers.onRelease(cleared)}>
                release all cleared ({cleared.length}) ▸
              </button>
            </div>
          ) : null}
          <Rows rows={rows} handlers={handlers} />
        </>
      ) : null}
    </section>
  );
}

export function Ledger({
  title,
  items,
  handlers,
  muted,
  eyebrows,
}: {
  title: string;
  items: Item[];
  handlers: Handlers;
  muted?: boolean;
  eyebrows?: boolean;
}) {
  if (items.length === 0) return null;

  // Two PRs on one ticket still have to land together, ledger or not.
  const byTicket = new Map<string, Item[]>();
  for (const item of items) {
    const key = item.issue?.id ?? `pr-${item.pr.id}`;
    byTicket.set(key, [...(byTicket.get(key) ?? []), item]);
  }

  return (
    <section>
      <div class={`ledger-head${muted ? " ledger-head--muted" : ""}`}>
        <span class="ledger-title">{title}</span>
        <span class="head-stat">
          {items.length} {items.length === 1 ? "PR" : "PRs"}
        </span>
      </div>
      <div class="rows">
        {[...byTicket.values()].flatMap((group) =>
          group.map((item, index) => (
            <Row
              key={item.pr.id}
              item={item}
              bracket={bracketFor(group, index)}
              eyebrow={eyebrows && item.issue?.parentId ? item.issue.parentId : undefined}
              picked={handlers.picked.has(item.pr.id)}
              onPick={() => handlers.onPick(item)}
              onRelease={() => handlers.onRelease([item])}
              busy={handlers.busy.has(item.pr.id)}
              expanded={handlers.open.has(item.pr.id)}
              onToggle={() => handlers.onToggle(item.pr.id)}
            />
          )),
        )}
      </div>
    </section>
  );
}
