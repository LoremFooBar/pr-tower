import type { Item, LinearIssue } from "@/core/types";
import { stripTicketPrefix } from "@/core/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { prLink } from "@/lib/prhub";
import {
  AlertTriangle,
  ArrowUpRight,
  CircleDashed,
  CircleCheck,
  CircleX,
  Clock,
  GitPullRequestArrow,
  Link2Off,
  Loader2,
  Send,
} from "lucide-react";

const PRIORITY = ["", "Urgent", "High", "Medium", "Low"];

export function priorityLabel(issue?: LinearIssue): string {
  return issue ? (PRIORITY[issue.priority] ?? "") : "";
}

/** What the row is waiting on, in one phrase, with the icon that matches it. */
export function state(item: Item) {
  const shut = item.gates.find((gate) => !gate.open);
  if (shut?.name === "path") {
    return { text: shut.reason, tone: "wait" as const, Icon: Link2Off };
  }
  if (shut?.name === "merge") {
    return { text: "Conflicts with base", tone: "bad" as const, Icon: AlertTriangle };
  }
  if (shut?.name === "ci") {
    const running = item.pr.checks === "pending";
    return {
      text: running ? "Checks running" : shut.reason,
      tone: running ? ("wait" as const) : ("bad" as const),
      Icon: running ? Loader2 : CircleX,
    };
  }
  if (item.lane === "merge") {
    return { text: "Approved · mergeable", tone: "ok" as const, Icon: CircleCheck };
  }
  if (item.lane === "flight") {
    if (item.pr.changesRequested > 0) {
      return { text: "Changes requested", tone: "bad" as const, Icon: CircleX };
    }
    if (item.pr.bugbot === "none" && item.pr.hasCI) {
      return { text: "In review · bot never ran", tone: "warn" as const, Icon: AlertTriangle };
    }
    return { text: "In review", tone: "wait" as const, Icon: CircleDashed };
  }
  if (item.pr.mergeState === "behind") {
    return { text: "Ready · behind base", tone: "muted" as const, Icon: CircleCheck };
  }
  return { text: "Ready to release", tone: "ok" as const, Icon: CircleCheck };
}

const TONE: Record<string, string> = {
  ok: "text-[var(--ok)]",
  warn: "text-[var(--warn)]",
  wait: "text-[var(--wait)]",
  bad: "text-destructive",
  muted: "text-muted-foreground",
};

/** CI / merge / blocked, as three dots. Hover gives the reason for each. */
export function GateDots({ item }: { item: Item }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-1" tabIndex={0}>
          {item.gates.map((gate) => (
            <span
              key={gate.name}
              className={cn(
                "size-1.5 rounded-full",
                gate.open
                  ? "bg-[var(--ok)]"
                  : gate.name === "path"
                    ? "bg-[var(--wait)]"
                    : "bg-destructive",
              )}
            />
          ))}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs">
        {item.gates.map((gate) => (
          <div key={gate.name}>
            {gate.label}: {gate.reason}
          </div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/** Approvals and bot verdict, for a PR already out for review. */
function ReviewState({ item }: { item: Item }) {
  const { pr } = item;
  const missing = pr.bugbot === "none" && pr.hasCI;
  return (
    <span className="text-muted-foreground flex items-center gap-1.5 font-mono text-[11px]">
      <span className={pr.approvals > 0 ? "text-[var(--ok)]" : undefined}>
        {pr.approvals} approved
      </span>
      {pr.changesRequested > 0 ? (
        <span className="text-destructive">· {pr.changesRequested} changes</span>
      ) : null}
      {missing ? <span className="text-[var(--warn)]">· no bot</span> : null}
    </span>
  );
}

interface RowProps {
  item: Item;
  picked?: boolean;
  onPick?(): void;
  onRelease?(): void;
  busy?: boolean;
  /** True on both PRs of a ticket that has to land in two places at once. */
  paired?: boolean;
  /** Names the parent epic when the row is not inside that epic's card. */
  eyebrow?: string;
}

export function Row({ item, picked, onPick, onRelease, busy, paired, eyebrow }: RowProps) {
  const { pr, issue } = item;
  const info = state(item);
  const releasable = item.lane === "send";

  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-md px-2 py-2 transition-colors",
        "hover:bg-muted/50",
        picked && "bg-primary/5 ring-primary/20 ring-1",
      )}
    >
      <div className="flex w-4 shrink-0 justify-center">
        {releasable && onPick ? (
          <Checkbox
            checked={picked}
            onCheckedChange={onPick}
            aria-label={`Select ${pr.repo} #${pr.number}`}
          />
        ) : (
          <GateDots item={item} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <a
            {...prLink(pr.url)}
            className="truncate text-sm font-medium hover:underline"
            title={pr.title}
          >
            {stripTicketPrefix(pr.title)}
          </a>
          {paired ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="shrink-0 gap-1 text-[10px] font-normal">
                  <GitPullRequestArrow className="size-3" />
                  pair
                </Badge>
              </TooltipTrigger>
              <TooltipContent>Lands together with the other PR on this ticket</TooltipContent>
            </Tooltip>
          ) : null}
        </div>

        <div className="text-muted-foreground mt-0.5 flex items-center gap-2 font-mono text-[11px]">
          {issue ? (
            <a href={issue.url} target="_blank" rel="noreferrer" className="hover:text-foreground">
              {issue.id}
            </a>
          ) : null}
          <span className="truncate">
            {pr.repo} #{pr.number}
          </span>
          {eyebrow ? <span className="truncate">· {eyebrow}</span> : null}
        </div>
      </div>

      {item.lane === "flight" || item.lane === "merge" ? (
        <ReviewState item={item} />
      ) : (
        <span className={cn("flex items-center gap-1.5 text-xs", TONE[info.tone])}>
          <info.Icon className={cn("size-3.5", info.Icon === Loader2 && "animate-spin")} />
          <span className="hidden truncate sm:inline">{info.text}</span>
        </span>
      )}

      <span className="text-muted-foreground flex w-12 shrink-0 items-center justify-end gap-1 font-mono text-[11px]">
        <Clock className="size-3" />
        {item.idleDays}d
      </span>

      <div className="flex w-[104px] shrink-0 justify-end">
        {releasable && onRelease ? (
          <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={onRelease} disabled={busy}>
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
            Release
          </Button>
        ) : (
          <a
            {...prLink(pr.url)}
            className="text-muted-foreground hover:text-foreground opacity-0 transition-opacity group-hover:opacity-100"
            aria-label="Open on GitHub"
          >
            <ArrowUpRight className="size-4" />
          </a>
        )}
      </div>
    </div>
  );
}
