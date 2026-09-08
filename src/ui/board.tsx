import { useState } from "react";
import type { Group, Item, SpineCell, Stage } from "@/core/types";
import type { Model } from "@/core/model";
import { stripTicketPrefix } from "@/core/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { prLink } from "@/lib/prhub";
import { priorityLabel, Row, Tie } from "./parts";
import { ChevronRight, Send, Sparkles } from "lucide-react";

export interface Handlers {
  picked: Set<number>;
  onPick(item: Item): void;
  onRelease(items: Item[]): void;
  busy: Set<number>;
}

const CELL: Record<SpineCell, string> = {
  done: "bg-[var(--done)]",
  cleared: "bg-primary",
  needs: "bg-destructive",
  waiting: "bg-[var(--wait)]",
  blocked: "bg-transparent ring-1 ring-inset ring-muted-foreground/50",
};

const CELL_NAME: Record<SpineCell, string> = {
  done: "done",
  cleared: "ready to release",
  needs: "needs you",
  waiting: "in review",
  blocked: "blocked",
};

// The five stages, in the order of the ladder every list sorts on, and in the
// words the bay header already counts them with.
const STAGE_ORDER: Stage[] = ["merge", "ready", "needs", "review", "blocked"];

export const STAGE_LABEL: Record<Stage, string> = {
  merge: "to merge",
  ready: "ready",
  needs: "need you",
  review: "in review",
  blocked: "blocked",
};

// Said as a sentence rather than as a tally, for the empty state.
export const STAGE_PROSE: Record<Stage, string> = {
  merge: "ready to merge",
  ready: "ready to release",
  needs: "waiting on you",
  review: "in review",
  blocked: "blocked",
};

// The same colours the spine uses, so a chip and a cell read as one vocabulary.
const STAGE_DOT: Record<Stage, string> = {
  merge: "bg-[var(--ok)]",
  ready: "bg-primary",
  needs: "bg-destructive",
  review: "bg-[var(--wait)]",
  blocked: "ring-muted-foreground/60 ring-1 ring-inset",
};

/**
 * Toggles, not tabs: none picked is the whole board, and picking two widens
 * rather than navigates. The counts are of everything the text filter leaves,
 * so turning one chip on does not zero the rest.
 */
export function Stages({
  counts,
  picked,
  onToggle,
  onClear,
}: {
  counts: Record<Stage, number>;
  picked: Set<Stage>;
  onToggle(stage: Stage): void;
  onClear(): void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {STAGE_ORDER.map((stage) => {
        const on = picked.has(stage);
        const count = counts[stage];
        return (
          <button
            key={stage}
            type="button"
            data-stage={stage}
            aria-pressed={on}
            disabled={count === 0 && !on}
            onClick={() => onToggle(stage)}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
              on
                ? "border-foreground/25 bg-muted text-foreground font-medium"
                : "text-muted-foreground hover:bg-muted/50 border-transparent",
              count === 0 && !on && "opacity-40 hover:bg-transparent",
            )}
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", STAGE_DOT[stage])} />
            {STAGE_LABEL[stage]}
            <span className="font-mono tabular-nums">{count}</span>
          </button>
        );
      })}
      {picked.size > 0 ? (
        <button
          type="button"
          data-stage-clear
          onClick={onClear}
          className="text-muted-foreground hover:text-foreground ml-1 rounded-md px-1.5 py-1 text-xs underline-offset-4 hover:underline"
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}

/** One cell per sub-issue, read left to right: the shape of the whole effort. */
function Spine({ cells }: { cells: SpineCell[] }) {
  const tally = cells.reduce<Record<string, number>>((all, cell) => {
    all[cell] = (all[cell] ?? 0) + 1;
    return all;
  }, {});
  const summary = Object.entries(tally)
    .map(([cell, count]) => `${count} ${CELL_NAME[cell as SpineCell]}`)
    .join(" · ");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-[2px]" tabIndex={0} aria-label={summary}>
          {cells.map((cell, index) => (
            <span key={index} className={cn("h-3.5 w-1.5 rounded-[2px]", CELL[cell])} />
          ))}
        </span>
      </TooltipTrigger>
      <TooltipContent>{summary}</TooltipContent>
    </Tooltip>
  );
}

function pairsOf(group: Group) {
  return group.tickets.map((ticket) => ticket.items);
}

export function Queue({ model, handlers }: { model: Model; handlers: Handlers }) {
  const cleared = model.queue;
  // Collapsed by default: every one of these PRs also has a row in its epic
  // below, so the cards are a second telling. What the header keeps is the only
  // thing the bays cannot give — one release across every epic at once.
  const [open, setOpen] = useState(false);

  if (cleared.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="text-muted-foreground py-6 text-center text-sm">
          {model.closest ? (
            <>
              Nothing is ready to release. Closest is{" "}
              <span className="text-foreground font-mono">
                {model.closest.issue?.id ?? `${model.closest.pr.repo} #${model.closest.pr.number}`}
              </span>{" "}
              — {(model.closest.gates.find((gate) => !gate.open)?.reason ?? "").toLowerCase()}.
            </>
          ) : (
            <>Nothing is ready to release, and no draft is close.</>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section>
        <div className="flex items-center gap-2">
          <CollapsibleTrigger asChild>
            <button className="hover:text-foreground text-foreground/90 flex items-center gap-2 rounded-md text-sm font-semibold transition-colors">
              <ChevronRight
                className={cn(
                  "text-muted-foreground size-4 shrink-0 transition-transform",
                  open && "rotate-90",
                )}
              />
              <Sparkles className="text-primary size-4" />
              Ready to release
              <Badge variant="secondary" className="font-mono">
                {cleared.length}
              </Badge>
            </button>
          </CollapsibleTrigger>
          <div className="flex-1" />
          {cleared.length > 1 ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 text-xs"
              onClick={() => handlers.onRelease(cleared)}
            >
              <Send className="size-3" />
              Release all {cleared.length}
            </Button>
          ) : null}
        </div>

        <CollapsibleContent className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cleared.map((item) => {
          const picked = handlers.picked.has(item.pr.id);
          return (
            <Card
              key={item.pr.id}
              className={cn("gap-0 py-4 transition-colors", picked && "border-primary bg-primary/5")}
            >
              <CardContent className="flex flex-col gap-3 px-4">
                <div className="flex items-start gap-2.5">
                  <Checkbox
                    checked={picked}
                    onCheckedChange={() => handlers.onPick(item)}
                    className="mt-0.5"
                    aria-label={`Select ${item.pr.repo} #${item.pr.number}`}
                  />
                  <a
                    {...prLink(item.pr.url)}
                    className="line-clamp-2 flex-1 text-sm leading-snug font-medium hover:underline"
                  >
                    {stripTicketPrefix(item.pr.title)}
                  </a>
                </div>

                <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 font-mono text-[11px]">
                  {item.issue ? <span>{item.issue.id}</span> : null}
                  <span>
                    {item.pr.repo} #{item.pr.number}
                  </span>
                  {item.stack ? (
                    <span>
                      stack {item.stack.position} of {item.stack.size}
                    </span>
                  ) : null}
                  {item.pr.additions !== undefined ? (
                    <span>
                      +{item.pr.additions} −{item.pr.deletions}
                    </span>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-1">
                  {item.scoreParts.map((part) => (
                    <Badge key={part.label} variant="outline" className="font-normal">
                      {part.label}
                    </Badge>
                  ))}
                </div>

                <Button
                  size="sm"
                  className="h-8 w-full gap-1.5"
                  onClick={() => handlers.onRelease([item])}
                  disabled={handlers.busy.has(item.pr.id)}
                >
                  <Send className="size-3.5" />
                  Release for review
                </Button>
              </CardContent>
            </Card>
          );
        })}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

export function Bay({
  group,
  defaultOpen,
  handlers,
}: {
  group: Group;
  defaultOpen: boolean;
  handlers: Handlers;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const tickets = pairsOf(group);
  const rows = tickets.flat();
  const cleared = rows.filter((item) => item.lane === "send");
  const priority = priorityLabel(group.epic);

  const counts = [
    group.rollup ? `${group.rollup.done}/${group.rollup.live} done` : null,
    ...STAGE_ORDER.filter((stage) => group.stages[stage] > 0).map(
      (stage) => `${group.stages[stage]} ${STAGE_LABEL[stage]}`,
    ),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card className="gap-0 py-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button className="hover:bg-muted/40 flex w-full items-start gap-3 rounded-t-xl px-4 py-3.5 text-left transition-colors">
            <ChevronRight
              className={cn(
                "text-muted-foreground mt-0.5 size-4 shrink-0 transition-transform",
                open && "rotate-90",
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {group.epic ? (
                  <span className="text-muted-foreground font-mono text-xs">{group.epic.id}</span>
                ) : null}
                <span className="truncate text-sm font-semibold">{group.title}</span>
                {priority ? (
                  <Badge
                    variant={priority === "Urgent" ? "destructive" : "secondary"}
                    className="text-[10px]"
                  >
                    {priority}
                  </Badge>
                ) : null}
                {group.epic ? (
                  <Badge variant="outline" className="text-[10px] font-normal">
                    {group.epic.stateName}
                  </Badge>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <Spine cells={group.spine} />
                <span className="text-muted-foreground font-mono text-[11px]">{counts}</span>
              </div>
            </div>
            <span
              className={cn(
                "shrink-0 text-xs",
                group.move.kind === "release" || group.move.kind === "merge"
                  ? "text-primary font-medium"
                  : group.move.kind === "fix"
                    ? "text-destructive"
                    : "text-muted-foreground",
              )}
            >
              {group.move.kind === "waiting" ? group.move.text : `Next: ${group.move.text}`}
            </span>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <Separator />
          <div className="space-y-0.5 p-2">
            {cleared.length > 1 ? (
              <div className="flex justify-end px-2 pt-1 pb-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => handlers.onRelease(cleared)}
                >
                  <Send className="size-3" />
                  Release all ready ({cleared.length})
                </Button>
              </div>
            ) : null}
            {tickets.map((ticket) => (
              <Tie key={ticket[0].pr.id} tied={ticket.length > 1}>
                {ticket.map((item) => (
                  <Row
                    key={item.pr.id}
                    item={item}
                    paired={ticket.length > 1}
                    picked={handlers.picked.has(item.pr.id)}
                    onPick={() => handlers.onPick(item)}
                    onRelease={() => handlers.onRelease([item])}
                    busy={handlers.busy.has(item.pr.id)}
                  />
                ))}
              </Tie>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

export function Ledger({
  title,
  items,
  handlers,
  muted,
}: {
  title: string;
  items: Item[];
  handlers: Handlers;
  muted?: boolean;
}) {
  if (items.length === 0) return null;

  const byTicket = new Map<string, Item[]>();
  for (const item of items) {
    const key = item.issue?.id ?? `pr-${item.pr.id}`;
    byTicket.set(key, [...(byTicket.get(key) ?? []), item]);
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className={cn("text-sm font-semibold", muted && "text-muted-foreground")}>{title}</h2>
        <Badge variant="secondary" className="font-mono">
          {items.length}
        </Badge>
      </div>
      <Card className="gap-0 py-2">
        <CardContent className="space-y-0.5 px-2">
          {[...byTicket.values()].map((group) => (
            <Tie key={group[0].pr.id} tied={group.length > 1}>
              {group.map((item) => (
                <Row
                  key={item.pr.id}
                  item={item}
                  paired={group.length > 1}
                  eyebrow={item.epicId}
                  picked={handlers.picked.has(item.pr.id)}
                  onPick={() => handlers.onPick(item)}
                  onRelease={() => handlers.onRelease([item])}
                  busy={handlers.busy.has(item.pr.id)}
                />
              ))}
            </Tie>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
