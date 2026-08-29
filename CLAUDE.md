# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What is this?

PR Tower ranks the user's open pull requests and sends the ready ones out for
review. It ships as a **Docker container**: a small Node server that holds the
credentials and serves one self-contained HTML page. React 19 + TypeScript +
Vite + Tailwind 4 + shadcn/ui for the client, plain `node:http` for the server.

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
- **The page's CSP allows no external anything** and no injected script. Tailwind
  and React are inlined at build time, so this still holds.

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
  index.ts    http server: /api/status, /api/config, /api/data, /api/events, /api/send
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

## Staying current

The server refreshes itself every five minutes and pushes a `sync` event,
carrying only the snapshot timestamp, down `/api/events` to every open page. The
page then re-reads `/api/data`, which is served from the snapshot it just built.

Three things about it:

- **The event carries a timestamp, not data.** The fetch that holds a token
  still happens only inside the container, and the stream stays cheap enough to
  ignore.
- **The background pull raises no spinner.** The Sync button's spinner answers
  for a press; a board that stirs on a timer nobody touched reads as a fault.
- **Write the SSE headers with a first chunk.** Node holds headers back until
  something is written, so a subscriber cannot tell an open stream from a stalled
  one until the first `: open` comment arrives. `npm run verify` covers this.

`FRESH_MS` still guards client-driven loads, but the five-minute timer means the
snapshot is rarely old enough for it to matter.

## Opening a PR in Chrome

A PR link is a real `<a href>` to github.com and stays one. When the PR Hub
extension (`~/repos/PR-HUB`) is installed its content script marks the page with
`data-pr-hub="1"`; only then does `prLink` (`src/lib/prhub.ts`) intercept a plain
left-click and post the URL to the extension, which brings the PR up in its
"My PRs" tab group instead of opening a duplicate tab.

- **This page can never do it alone.** Tab groups are `chrome.tabGroups`, an
  extension-only API. A custom URL scheme does not help: handler URLs must be
  HTTP(S), so they land on a page with the same limitation.
- **Modified clicks are left alone.** Cmd/Ctrl/Shift/Alt and any non-primary
  button keep the browser's own behaviour, and with no extension present nothing
  is intercepted at all.

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
- **Nothing is said twice on one row.** The card's reason chips own the score, so
  the card foot does not repeat idle days.
- **PRs of one ticket land together.** They are tied by a rule in the row gutter
  and select as a pair, because the gutter's glyph slot is taken by the release
  checkbox — exactly the row where the pairing matters most.
- **Blocked is not "need you".** A bay's counts separate them; there is nothing
  to do about a blocked PR yet.

## Information architecture

There are **no tabs**. Readiness was tried as the navigation axis and rejected by
the user: "I don't care that much about overall prs status so the tabs are
currently useless to me." Every real decision needs readiness *and* context at
once, so readiness is demoted — visible always, navigated never.

One scrolling page, in this order:

1. **Cleared queue** — pinned cards for every draft whose three gates are open,
   ranked by score. When empty it names the draft closest to clearing.
2. **Bays** — one per epic, ordered by epic priority then id. The order is
   deliberately **stable**: a board kept open all day must not reshuffle between
   glances. Urgency already has a home in the queue.
3. **Singles ledger** — one-PR epics and standalone tickets, one row each.
4. **No ticket** — tooling PRs, muted, last.

**A bay exists only for an epic with two or more open PRs.** A single PR of
information costs a single row, so a 1-PR epic never generates as much furniture
as the 7-PR one. This is `Group.bay` in the model.

Rows everywhere sort on one ladder (`rung` in `model.ts`): cleared → needs-you →
waiting → blocked-by-dependency. Blocked sorts *last*, below even the PRs waiting
on other people, because there is nothing to do about it until the other ticket
lands.

## Design

**shadcn/ui, deliberately.** The first two attempts were hand-written CSS — an
instrument panel, then a flight-strip board — and both were rejected: "design
still not appealing", then "anything will look better than what we have right
now". That is three rejections of bespoke visual direction, so the look is now a
well-executed conventional one rather than a distinctive one. Do not reintroduce
a custom design system here.

Components live in `src/components/ui`, added with `npx shadcn@latest add`. They
are ours to edit, but prefer the default styling: its familiarity is the point.

Two things are held outside the shadcn palette on purpose, in `src/styles.css`:

- `--ok`, `--warn`, `--wait`, `--done` carry *work state*. A theme change must
  not silently repaint the meaning of a row.
- The embedded fonts (Geist, Geist Mono) come from `npm run fonts`, so the page
  still makes no external request. The favicon is an inline SVG data URI in
  `index.html` for the same reason: the CSP would refuse to fetch a file.

The one bespoke element that survived is the **bay spine** — one cell per
sub-issue across a parent task, read left to right: done, ready, needs you, in
review, blocked. Nothing off the shelf says "how much of this effort is left",
and the done cells depend on the rollup query.

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
