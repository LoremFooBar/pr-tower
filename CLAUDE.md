# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What is this?

PR Tower ranks the user's open pull requests and sends the ready ones out for
review. It ships as a **Docker container**: a small Node server that holds the
credentials and serves one self-contained HTML page. Preact + TypeScript + Vite
for the client, plain `node:http` for the server.

It replaced a Chrome extension (`~/repos/PR-TOWER`, itself a fork of
`~/repos/PR-HUB`). That extension still exists but this is the live line of work.

## Why a server, when the client could talk to both APIs directly

It did, at first — both APIs allow cross-origin browser calls (`api.github.com`
sends `access-control-allow-origin: *`; `api.linear.app` reflects any `Origin`,
including the `null` a `file://` page sends), so the whole thing ran as one file
opened from disk.

That was abandoned for one measured reason: **every `file://` page in Chromium
shares a single `localStorage` partition.** A page in one directory read a token
written by a page in another. A `repo`-scoped PAT sitting there is readable by
any local HTML file the user ever opens. The server exists so the browser holds
no credential at all.

Do not move the tokens back to the client.

## Security properties to preserve

- **The browser never receives a token.** `/api/status` reports whether one is
  set, never its value. `npm run verify` asserts this against both the API and
  the served HTML.
- **Loopback only.** `docker-compose.yml` publishes `127.0.0.1:5178:5178`. The
  API has no login of its own, so exposing it on a LAN would hand it to anyone.
- **Cross-origin requests are refused** outright, and writes must be
  `application/json`, which forces a preflight the origin check then fails.
  Together these stop a page the user is browsing from driving the API.
- **An env-supplied token is never written to the volume.** Whoever set
  `GITHUB_TOKEN` kept it out of the volume deliberately; persisting a copy would
  widen where the secret lives and outlive the variable meant to control it.
  This was a real bug once — it wrote an ambient `GITHUB_TOKEN` to disk.
  `tests/config.test.ts` covers it.
- **The page's CSP allows no external anything** and no injected script. That is
  why the verification harness polls from the test side instead of using
  `waitForFunction`.

## Build

The client single file comes from a custom Vite plugin (`inlineEverything` in
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
server/       runs in the container, holds the credentials
  index.ts    http server: /api/status, /api/config, /api/data, /api/send
  config.ts   token storage in /data, env overrides
  github.ts   REST reads, and the one GraphQL write
  linear.ts   Linear GraphQL reads
src/core/     pure logic, all unit tested, runs in the browser
  types.ts    shared shapes, imported by both sides
  link.ts     PR to Linear ticket join, ticket-key parsing
  rank.ts     gates, signals, and the importance score
  model.ts    buildModel: PRs to tickets to parent epics, plus the send queue
  api.ts      the client's only outside contact — this app's own backend
  store.ts    a date helper; the browser stores nothing
src/ui/       Preact components
tools/        font embedding, the mock upstream, the verification harness
```

The server does the fetching and caching; the browser does the modelling and the
rendering. `src/core/types.ts` is the contract, imported by both.

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

`npm test` covers the pure core and token storage. `npm run verify` is the
important one: it starts `tools/mock-upstream.mjs` in place of GitHub and Linear,
starts the **real** `dist/server.js` against it, then drives the **real** page in
headless Chromium — setup screen, every lane, a completed send — and asserts the
send reached the server and no response leaked a token.

Two harness details that are not obvious:

- The page's CSP blocks Playwright's injected polling, so waits are polled from
  the test side with `page.textContent`.
- Scope those reads to `#app`, never `body`: the inlined bundle lives inside
  `<body>`, so `body.textContent` contains the entire program source, and any
  string you search for is in it.
