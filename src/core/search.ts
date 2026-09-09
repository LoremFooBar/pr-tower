import { stageOf } from "./rank";
import type { Item, MergedPR, Stage } from "./types";

/**
 * The fields a row is findable by, whatever kind of row it is. Open PRs and
 * merged PRs answer to one filter grammar because they sit on one page; keeping
 * the grammar in one place is what makes the next kind of row cheap.
 */
export interface Searchable {
  title: string;
  repo: string;
  number: number;
  ticket?: string;
  epic?: string;
}

// The branch is left out on purpose: it repeats the ticket key most of the time
// and would otherwise match a token the row never shows, which reads as a wrong
// result.
export function searchableItem(item: Item): Searchable {
  return {
    title: item.pr.title,
    repo: item.pr.repo,
    number: item.pr.number,
    ticket: item.issue?.id,
    epic: item.epicId,
  };
}

export function searchableMerged(pr: MergedPR): Searchable {
  return { title: pr.title, repo: pr.repo, number: pr.number, ticket: pr.issueKey };
}

function haystack(row: Searchable): string {
  return [row.title, row.repo, `#${row.number}`, row.ticket ?? "", row.epic ?? ""]
    .join(" ")
    .toLowerCase();
}

/**
 * Every token has to match something, so a second word narrows the result
 * rather than widening it. A leading # is dropped from the token: a PR gets
 * written both "#6845" and "6845".
 */
export function matchesQuery(row: Searchable, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const text = haystack(row);
  return tokens.every((token) => text.includes(token.replace(/^#/, "")));
}

export function matchesStages(item: Item, stages: readonly Stage[]): boolean {
  return stages.length === 0 || stages.includes(stageOf(item));
}

/**
 * What the stage selection becomes when a chip is clicked.
 *
 * A plain click keeps only that stage, which is what the strip is for: one
 * click to answer "what is on me right now". Clicking the only stage that is on
 * turns it off again, so the whole board is always one click away without
 * reaching for Clear. Cmd or Ctrl adds and removes instead, the same modifier a
 * file list uses for the same job.
 */
export function nextStages(
  current: ReadonlySet<Stage>,
  stage: Stage,
  additive: boolean,
): Set<Stage> {
  if (additive) {
    const next = new Set(current);
    if (!next.delete(stage)) next.add(stage);
    return next;
  }
  return current.size === 1 && current.has(stage) ? new Set() : new Set([stage]);
}
