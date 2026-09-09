import { useState } from "react";
import type { DeployState, DeployStep, MergedPR } from "@/core/types";
import { blocker, isLive, mergedLine } from "@/core/merged";
import { stripTicketPrefix } from "@/core/link";
import { timeAgo } from "@/core/store";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { prLink } from "@/lib/prhub";
import { ChevronRight, Rocket } from "lucide-react";

// The work-state palette, not the theme's: a theme change must not repaint what
// a deploy is doing. "none" is an outline, because nothing has run yet — grey
// fill would read as done.
const PILL: Record<DeployState, string> = {
  ok: "bg-[var(--ok)]/12 text-[var(--ok)] border-[var(--ok)]/30",
  running: "bg-[var(--wait)]/12 text-[var(--wait)] border-[var(--wait)]/30",
  waiting: "bg-[var(--warn)]/12 text-[var(--warn)] border-[var(--warn)]/30",
  failed: "bg-destructive/12 text-destructive border-destructive/30",
  none: "text-muted-foreground border-border",
};

const SAYS: Record<DeployState, string> = {
  ok: "done",
  running: "running",
  waiting: "waiting for approval",
  failed: "failed",
  none: "not started",
};

// A workflow name is a sentence; an environment name is a word. Only the long
// one needs shortening, and only for the pill — the tooltip says it in full.
function short(step: DeployStep): string {
  if (step.kind === "environment") return step.name;
  return step.name.replace(/\b(pipeline|workflow|deployment|deploy)\b/gi, "").trim() || step.name;
}

function Pill({ step }: { step: DeployStep }) {
  const who = step.youCanApprove
    ? "You can approve this."
    : step.approvers?.length
      ? `Waiting on ${step.approvers.join(", ")}.`
      : "";

  const pill = (
    <span
      className={cn(
        "rounded-full border px-1.5 py-0.5 font-mono text-[10px] leading-none whitespace-nowrap",
        PILL[step.state],
      )}
    >
      {short(step)}
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {step.url ? (
          <a href={step.url} target="_blank" rel="noreferrer">
            {pill}
          </a>
        ) : (
          <span>{pill}</span>
        )}
      </TooltipTrigger>
      <TooltipContent>
        {step.name} — {SAYS[step.state]}
        {who ? ` ${who}` : ""}
        {step.at ? ` · ${timeAgo(Date.parse(step.at))}` : ""}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Merged PRs and how far each has shipped. Collapsed it is one line that leads
 * with anything stuck, which is the whole point: a section that empties itself
 * cannot be told apart from a fetch that broke.
 */
export function Merged({ view, days }: { view: MergedPR[]; days: number }) {
  const [open, setOpen] = useState(false);
  const stuck = view.some((pr) => !isLive(pr));

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section data-merged>
        <div className="flex items-center gap-2">
          <CollapsibleTrigger asChild>
            <button className="hover:text-foreground text-foreground/90 flex items-center gap-2 rounded-md text-sm font-semibold transition-colors">
              <ChevronRight
                className={cn(
                  "text-muted-foreground size-4 shrink-0 transition-transform",
                  open && "rotate-90",
                )}
              />
              <Rocket className={cn("size-4", stuck ? "text-destructive" : "text-[var(--ok)]")} />
              Merged
              <span
                className={cn(
                  "font-mono text-xs font-normal",
                  stuck ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {mergedLine(view, days)}
              </span>
            </button>
          </CollapsibleTrigger>
        </div>

        <CollapsibleContent className="mt-3">
          {view.length === 0 ? null : (
            <Card className="gap-0 py-2">
              <CardContent className="space-y-0.5 px-2">
                {view.map((pr) => {
                  const live = isLive(pr);
                  const stop = blocker(pr);
                  return (
                    <div
                      key={pr.id}
                      data-merged-pr
                      className="hover:bg-muted/40 flex items-center gap-3 rounded-md px-2 py-1.5"
                    >
                      <a
                        {...prLink(pr.url)}
                        className={cn(
                          "min-w-0 flex-1 truncate text-sm hover:underline",
                          live && "text-muted-foreground",
                        )}
                      >
                        {stripTicketPrefix(pr.title)}
                      </a>

                      <span className="text-muted-foreground hidden shrink-0 font-mono text-[11px] sm:inline">
                        {pr.issueKey ? `${pr.issueKey} ` : ""}
                        {pr.repo} #{pr.number}
                      </span>

                      <span className="flex shrink-0 items-center gap-1">
                        {pr.steps.length === 0 ? (
                          <Badge variant="outline" className="text-[10px] font-normal">
                            no run
                          </Badge>
                        ) : (
                          pr.steps.map((step, index) => <Pill key={index} step={step} />)
                        )}
                      </span>

                      <span
                        className={cn(
                          "text-muted-foreground w-14 shrink-0 text-right font-mono text-[11px]",
                          !live && stop?.state === "failed" && "text-destructive",
                        )}
                      >
                        {timeAgo(Date.parse(pr.mergedAt))}
                      </span>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
