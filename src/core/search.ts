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
