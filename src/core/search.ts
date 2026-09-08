import { stageOf } from "./rank";
import type { Item, Stage } from "./types";

// What a PR is findable by. The branch is left out on purpose: it repeats the
// ticket key most of the time and would otherwise match a token the row never
// shows, which reads as a wrong result.
function haystack(item: Item): string {
  return [
    item.pr.title,
    item.pr.repo,
    `#${item.pr.number}`,
    item.issue?.id ?? "",
    item.epicId ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Every token has to match something, so a second word narrows the result
 * rather than widening it. A leading # is dropped from the token: a PR gets
 * written both "#6845" and "6845".
 */
export function matchesQuery(item: Item, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const text = haystack(item);
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
