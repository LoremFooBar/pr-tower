# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What is this?

PR Tower ranks the user's open pull requests and sends the ready ones out for
review. It ships as a **Docker container**: a small Node server that holds the
credentials and serves one self-contained HTML page. React 19 + TypeScript +
Vite + Tailwind 4 + shadcn/ui for the client, plain `node:http` for the server.

It replaced a Chrome extension, itself a fork of `~/repos/PR-HUB`; that fork has
been deleted. PR Hub is still in use and still separate — see "Opening a PR in
Chrome" for the one place the two tools meet.

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

## Installable

The page is installable as a PWA, so it gets its own window and dock icon rather
than a browser tab. No service worker: one is **not** required for
installability, and a caching worker would fight the `no-store` on the page and
eventually serve a stale bundle from a rebuilt image. Offline would buy nothing
anyway — the app is inert without its server.

That costs the single-file property a little, and the CSP two directives:

- **Three files leave the bundle**: `public/manifest.webmanifest` and two icons
  (plus a maskable one). A manifest cannot be inlined, and manifest icons cannot
  be data URIs. `INSTALL_FILES` in `server/index.ts` serves them from a fixed
  map, so no path comes from the request.
- **`img-src 'self'` and `manifest-src 'self'`** join the policy. Nothing
  external became reachable; `npm run verify` asserts the policy still carries
  `default-src 'none'` and names no host.
- **Icons are committed, like the fonts.** `npm run icons` renders them from the
  favicon already inlined in `index.html`, so the mark has one source of truth.
  It cannot be part of `npm run build`: the image builds with `npm ci`, which
  installs no Playwright browser.
- **`localhost` is enough.** Chromium allows install from `localhost` and
  `127.0.0.1` without HTTPS, so the loopback-only rule is untouched.

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
- **When two tickets claim one PR, the ticket the PR names wins.** A parent and
  the child a PR was opened for can both list its URL, and the index keeps only
  the last one read — so which ticket a PR landed under depended on the order
  Linear returned the issues. `linkPR` now prefers a claimant the PR's own title
  or branch names. Linear's attachment still wins for a PR whose title carries no
  key at all.
- **A bay belongs to the epic at the top of the chain, not to the ticket one
  level up.** Linear nests as deep as you like, and grouping by the immediate
  parent put a grandchild in a group of its own — which never reaches the two
  PRs a bay needs, so it dropped into the singles ledger while its siblings sat
  in the epic's bay. `rootOf` in `model.ts` walks to the top. The same walk fills
  `Item.epicId`, which is what the ledger's eyebrow names: the immediate parent
  is not reliably the epic.
- **Nothing is said twice on one row.** The card's reason chips own the score, so
  the card foot does not repeat idle days.
- **Stacking is context, not a gate.** A PR branched off another open PR is
  perfectly reviewable — reviewers usually want the whole stack at once — so it
  keeps its lane and its place in the queue and only carries a badge naming the
  parent. Same reasoning as "behind base". The Path gate stays reserved for a
  Linear blocker, which says the *work* cannot proceed, not merely the merge.
- **A stack is read two ways, and the branch names come first.** `stacks` in
  `model.ts` matches one PR's `baseRef` to another's `headRef` in the same repo —
  free, exact, and the only reading that works once a PR is retargeted. GitHub
  retargets a child when its parent merges, so passing only open PRs makes the
  relation clear itself, exactly as `openTickets` spends a Linear blocker.
- **The second reading catches a stack GitHub was never told about**: PRs each
  opened against `main` with the branches chained in git anyway. One PR's commit
  list then contains another's head commit, because GitHub lists a PR's commits
  relative to its base — which is also why a *declared* stack shows no overlap at
  all, and why the branch rule cannot be dropped. In a chain of three the top PR
  holds both other heads, so the nearer parent is the one with more commits; an
  equal count is two branches at one commit and nobody's parent.
- **The commit lists cost a call per PR, so only repositories with more than one
  open PR pay it.** A stack cannot span repositories, so nothing is lost. The
  first page of 100 commits is enough: the list is oldest-first, and a parent's
  head sits at that end.
- **Every PR of a stack is badged, the bottom one included**, and the badge is
  its position: `2 of 3`. Tagging only the PRs that sit on something else would
  leave the one that merges first looking unrelated to the chain it starts. The
  chain is walked in both directions, so the size is the whole stack rather than
  the part above any one PR.
- **PRs of one ticket land together.** They select as a pair and are tied by a
  bracket drawn *beside* the gutter, not in it: the gutter's own slot is taken by
  the release checkbox, which is exactly the row where the pairing matters most.
  Every group carries the same left padding, tied or not, so a single row does
  not shift when its neighbour gains a partner (`Tie` in `parts.tsx`).
- **The bracket does not extend to stacks.** It can only join rows that sit
  together, and rows are grouped by ticket — a pair always is, a stack often is
  not, since a stacked PR usually carries its own ticket. That is why a stack
  says its position instead.
- **Out of draft is not the same as being read.** `reviewers` on a PR is
  everyone who submitted a review of any kind, the author and every bot removed:
  GitHub records a lone inline comment as a review of state `COMMENTED`, so this
  comes free from the reviews call already made. The row names them only while
  there is no approval and no changes requested, because a verdict already
  implies somebody read it. A plain comment in the conversation box is not a
  review and does not appear — catching those would cost a call per PR.
- **A reviewer's avatar is inlined, never linked.** The page's CSP allows no
  external image, and one decoration is not worth making the page fetch from
  another host for the first time. The server pulls each distinct avatar at
  `?s=48`, base64s it into the snapshot, and caches it by URL so a returning
  reviewer costs nothing. It fetches only `avatars.githubusercontent.com` — or
  the stand-in API in a test — because the URL arrives inside an API response and
  nothing from outside should choose an address for the server. `npm run verify`
  asserts every image on the page is a `data:` URI.
- **Readers are named on a draft too.** Someone reads a draft as readily as a PR
  already out for review, so `readers` and the faces live in `Row` rather than in
  `ReviewState`, which only renders for the `flight` and `merge` lanes. They hold
  one column across every lane, so the faces can be scanned down the board.
- **`state()`'s `flight` branch never renders.** A row in that lane, and in
  `merge`, shows `ReviewState` instead. Put anything about a PR out for review
  there, and anything true of every lane in `Row`.
- **Blocked is not "need you".** A bay's counts separate them; there is nothing
  to do about a blocked PR yet.

## Information architecture

There are **no tabs**. Readiness was tried as the navigation axis and rejected by
the user: "I don't care that much about overall prs status so the tabs are
currently useless to me." Every real decision needs readiness *and* context at
once, so readiness is demoted — visible always, navigated never.

One scrolling page, in this order:

1. **Cleared queue** — collapsed to a single line by default, because every PR
   in it also has a row in its epic below and the cards were a second telling of
   the same thing. What the line keeps is the part the bays cannot give: the
   count, and one release across every epic at once. Expanded, it is a card per
   draft whose three gates are open, ranked by score. When empty it stays a
   sentence naming the draft closest to clearing.
   Radix drops collapsed content, so anything driving those cards — `npm run
   verify` included — has to open the section first.
2. **Bays** — one per epic, ordered by epic priority then id. The order is
   deliberately **stable**: a board kept open all day must not reshuffle between
   glances. Urgency already has a home in the queue.
3. **Singles ledger** — standalone tickets and tickets whose parent is not a real
   epic, one row each.
4. **No ticket** — tooling PRs, muted, last.

**A bay exists for an epic with two or more open PRs, or for a real epic — one
with more than one live sub-ticket — even when only one of its PRs is open.**
The first rule alone hid an epic's own section the moment its PRs landed one at a
time, which is exactly when the spine showing how much of the effort is left is
worth reading. The second reading needs the rollup, since a sibling with no open
PR is invisible to this tool. A parent of a single sub-ticket is not an epic and
stays a row in the ledger. This is `Group.bay` in the model.

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
