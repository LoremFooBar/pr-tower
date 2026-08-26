# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What is this?

PR Tower is a client-only web app that ranks the user's open pull requests and
sends the ready ones out for review. It builds to **one self-contained HTML
file** (`dist/index.html`) that runs from `file://` with no server and no
container. Preact + TypeScript + Vite.

It replaced a Chrome extension (`~/repos/PR-TOWER`, itself a fork of
`~/repos/PR-HUB`). That extension still exists but this is the live line of work.

## Why it can be client-only

Both APIs allow cross-origin browser requests, which is the whole reason no
proxy is needed:

- `api.github.com` sends `access-control-allow-origin: *`.
- `api.linear.app` **reflects** whatever `Origin` it is given, including `null`,
  which is what a `file://` page sends.

If either ever stops, the app needs a proxy and the single-file promise breaks.
Check with an `OPTIONS` preflight before assuming.

## Build

The single file comes from a custom Vite plugin (`inlineEverything` in
`vite.config.ts`). Two things there are load-bearing and were both real bugs:

1. **The replacement must be a function, not a string.** `String.replace` with a
   string expands `$&`, `$1` and friends, and minified JS is full of them — one
   `$&` re-inserts the matched `<script>` tag inside the inline script, whose
   `</script>` then closes it early and dumps the bundle into the page body.
2. **The script goes at the end of `<body>`.** Vite hoists the entry into
   `<head>`; a module script defers but an inline classic script does not, so
   left there it runs before `#app` exists and nothing renders.

The output format is `iife`, not `esm`: a browser refuses to load module scripts
over `file://`.

The plugin errors the build if a tag it expects to inline is not found, so a
silent half-inlined file cannot ship.

## Layout

```
src/core/     pure logic, all unit tested
  types.ts    shared shapes
  link.ts     PR to Linear ticket join, ticket-key parsing
  rank.ts     gates, signals, and the importance score
  model.ts    buildModel: PRs to tickets to parent epics, plus the send queue
  github.ts   REST reads, and the one GraphQL write
  linear.ts   Linear GraphQL reads
  store.ts    localStorage config and the cached snapshot
src/ui/       Preact components
tools/        font embedding and the browser verification harness
```

## Domain rules worth keeping

- **Three gates, no more.** CI, Merge, Path. They are the conditions under which
  a review wastes someone's time. "Behind base" and "idle" are context, not
  gates — a PR behind its base is perfectly reviewable.
- **The score is explained, never opaque.** `scoreFor` returns named parts, and
  the row renders them. Adding a component means adding a chip the user can
  argue with.
- **`mergeable_state`, never `mergeable`.** The latter is lazily computed and
  reports clean on conflicting PRs.
- **Bugbot skips drafts.** `no_bot` only fires on a non-draft in a repo with CI
  (`hasCI`), or every PR in a repo without Bugbot is falsely flagged.
- **A blocker is spent once its PR merges.** `openTickets` gates that.
- **An epic that owns a PR and sub-tickets groups under itself**, otherwise its
  own PR strands in "Standalone tickets".
- **Whatever a row explains in prose, it does not repeat as a pill.** The Held
  lane's gate line owns the blocking reason; the Send lane's chips own the
  ranking.

## Design

An instrument panel, deliberately not a dashboard. One accent (aqua), spent in
exactly one place: the moment a PR is clear to go out. Red and amber are state
only, so nothing competes with the release signal.

The signature is the **gate rail** — three bars at the left of every row that
fill as gates open and light aqua only when all three are. It is the same object
in every lane, which is what makes the Held lane readable at a glance: you see
*which* bar is dark.

Typefaces are Chivo and Chivo Mono, embedded as data URIs by
`npm run fonts` so the file makes no external request.

## Testing

`npm test` covers the pure core. `npm run verify` is the important one: it loads
the built file from `file://` in headless Chromium against a canned fixture,
walks every lane, and completes a send. Since the product *is* a file opened
with no server, that is the only test that checks the real thing.
