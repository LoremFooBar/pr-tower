import type { Group, Item } from "../core/types";
import type { Model } from "../core/model";
import { Row, Ticket, State } from "./parts";

function Section({ title, note, count }: { title: string; note: string; count?: number }) {
  return (
    <div class="section">
      <h2>{title}</h2>
      <p>{note}</p>
      {count !== undefined && <span class="count">{count}</span>}
    </div>
  );
}

function Empty({ head, body }: { head: string; body: string }) {
  return (
    <div class="empty">
      <strong>{head}</strong>
      {body}
    </div>
  );
}

interface QueueProps {
  items: Item[];
  selected: Set<number>;
  onToggle(id: number): void;
  onSend(item: Item): void;
  sendingIds: Set<number>;
}

export function Queue({ items, selected, onToggle, onSend, sendingIds }: QueueProps) {
  if (items.length === 0) {
    return (
      <Empty
        head="Nothing is ready to go out"
        body="Every draft is waiting on a gate. Check Held back to see which one."
      />
    );
  }

  return (
    <>
      <div class="intro">
        <div>
          <h1>Ready to send, most important first</h1>
          <p>
            All three gates are open on these: checks are green, nothing conflicts, and no
            other PR of yours is in the way. Order is by how much each one matters — the
            reasons under each row are the whole calculation.
          </p>
        </div>
      </div>
      {items.map((item, index) => (
        <Row
          key={item.pr.id}
          item={item}
          rank={index + 1}
          explain="score"
          selected={selected.has(item.pr.id)}
          onToggle={() => onToggle(item.pr.id)}
          onSend={() => onSend(item)}
          sending={sendingIds.has(item.pr.id)}
        />
      ))}
    </>
  );
}

export function Held({ items }: { items: Item[] }) {
  if (items.length === 0) {
    return <Empty head="Nothing held back" body="No draft is blocked by a gate right now." />;
  }
  // Closest to sendable first: one shut gate before two, then by importance.
  const ordered = [...items].sort(
    (a, b) =>
      a.gates.filter((g) => !g.open).length - b.gates.filter((g) => !g.open).length ||
      b.score - a.score,
  );
  return (
    <>
      <div class="intro">
        <div>
          <h1>Held back</h1>
          <p>
            Drafts with a gate shut, nearest to ready first. Each row names the one thing
            standing in the way.
          </p>
        </div>
      </div>
      {ordered.map((item) => (
        <Row key={item.pr.id} item={item} explain="gate" />
      ))}
    </>
  );
}

export function Flight({ items, merge }: { items: Item[]; merge: Item[] }) {
  if (items.length === 0 && merge.length === 0) {
    return <Empty head="Nothing out for review" body="No PR of yours is waiting on someone else." />;
  }
  return (
    <>
      {merge.length > 0 && (
        <>
          <Section
            title="Approved"
            note="Nothing is blocking these. They are waiting on you to merge."
            count={merge.length}
          />
          {merge.map((item) => (
            <Row key={item.pr.id} item={item} />
          ))}
        </>
      )}
      {items.length > 0 && (
        <>
          <Section
            title="Out for review"
            note="Already sent. Nothing to do but wait, unless a row flags a problem."
            count={items.length}
          />
          {items.map((item) => (
            <Row key={item.pr.id} item={item} />
          ))}
        </>
      )}
    </>
  );
}

function GroupCard({ group }: { group: Group }) {
  return (
    <div class="group">
      <div class="group-head">
        {group.epic ? (
          <a class="group-key" href={group.epic.url} target="_blank" rel="noreferrer">
            {group.epic.id}
          </a>
        ) : (
          <span class="group-key" style="color:var(--dim)">
            —
          </span>
        )}
        <span class="group-title" title={group.title}>
          {group.title}
        </span>
        <State issue={group.epic} />
        <span class="group-count">
          {group.count} {group.count === 1 ? "PR" : "PRs"}
          {group.repos > 1 ? ` · ${group.repos} repos` : ""}
        </span>
      </div>
      {group.tickets.map((ticket) => {
        const isEpic = ticket.issue && group.epic && ticket.issue.id === group.epic.id;
        return (
          <div class="ticket-node" key={ticket.key || "untracked"}>
            <div class="ticket-head">
              <Ticket issue={isEpic ? undefined : ticket.issue} fallback={ticket.key || undefined} />
              <span class="ticket-title">
                {isEpic
                  ? "on the parent ticket itself"
                  : (ticket.issue?.title ??
                    (ticket.key ? "Not found in Linear — is it assigned to you?" : "No linked ticket"))}
              </span>
              {!isEpic && <State issue={ticket.issue} />}
              {ticket.items.length > 1 && <span class="pill">{ticket.items.length} PRs</span>}
            </div>
            {ticket.items.map((item) => (
              <Row key={item.pr.id} item={item} hideTicket />
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function Tree({ model }: { model: Model }) {
  if (model.groups.length === 0) {
    return <Empty head="No open PRs" body="Nothing to group." />;
  }
  return (
    <>
      <div class="intro">
        <div>
          <h1>Everything, by ticket</h1>
          <p>
            Sub-tickets sit under their parent, so a large effort reads as one thing. A ticket
            with several PRs across repositories keeps them together.
          </p>
        </div>
      </div>
      {model.groups.map((group) => (
        <GroupCard key={group.key} group={group} />
      ))}
    </>
  );
}
