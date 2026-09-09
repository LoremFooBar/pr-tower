# PR Tower

Ranks your open pull requests and sends the ready ones out for review.

Runs as one small container. Your GitHub and Linear tokens stay inside it — the
browser never receives them, and every call to GitHub and Linear is made
server-side.

```bash
docker compose up -d --build
open http://localhost:5178
```

Then paste the two keys once. They are written to a Docker volume, readable only
by the container user, and never sent back to the page.

It restarts with Docker, so there is nothing to run by hand afterwards.

## What it does

The page is one board, with no tabs.

**Cleared** sits at the top: every draft whose three gates are open, ranked by
how much it matters, each with a release button. When nothing is cleared it names
the draft that is closest and what is holding it.

| Gate | Shut when |
|---|---|
| **CI** | A check failed, or checks are still running |
| **MG** | The branch conflicts with its base |
| **BL** | Linear says the ticket is blocked by another ticket that still has an open PR of yours |

Below it, one **bay per epic** — but only for an epic with two or more open PRs.
Each bay header carries a spine and a next move:

```
▾ ACME-288  USAGE-BASED BILLING ROLLOUT        URGENT · IN PROGRESS
  ▪▪▪▪▪▮▮▯▯▥▥  23 done · 2 cleared · 3 need you · 2 waiting   next → release ACME-1114
```

The spine is one cell per sub-issue: muted done, magenta cleared, amber needs
you, steel waiting, hollow blocked. Done cells come from a query that counts
every sub-ticket, including the ones assigned to nobody — without it, nothing
claims progress.

Everything with a single PR drops into the **Singles** ledger, one row each, with
its epic named inline. Tooling PRs with no ticket sit muted at the bottom.

Rows sort the same way everywhere: cleared, then what needs you, then what is
waiting on other people, then what is blocked by another ticket.

## Did it actually ship

Under the queue, a one-line strip of your recently merged PRs:

```
▸ Merged  deploy failed — management #1940 Main CI/CD Pipeline · 4 more not live · 15 live
▸ Merged  21 merged · all live
▸ Merged  Nothing merged in the last 7 days
```

The line always leads with whatever is stuck, so you can read it without opening
it. Expanded, one row per PR with a pill per workflow or environment: green done,
blue running, amber waiting for approval, red failed. A row held at an approval
gate names the environment and who has to approve it.

"Shipped" means CI ran on `main` for the merge commit. A deploy that was
cancelled because a later merge overtook it counts as shipped once that later run
contains your commit.

Merged PRs also show under their ticket in the bays, struck through and carrying
only the gates they are still stuck at, so a bay shows the whole effort rather
than the part still open.

Anything still moving sorts to the top. The window is set on the Settings screen
and trims finished rows only — a deploy that failed last week stays until you deal
with it.

## Finding things

A strip of **stage chips** sits above the queue, each with a count:

```
● to merge 1   ● ready 3   ● need you 3   ● in review 1   ○ blocked 1
```

Click one to see only that stage. Click it again to go back to the whole board.
Hold `Cmd` (or `Ctrl`) while clicking to add a second stage rather than replace
the first.

They are filters, not tabs — the page underneath does not change, and the header
keeps saying `4 of 9` so you always know what is hidden.

The text filter next to Sync searches the title, the repo, `#number`, the ticket
and the epic. Every word has to match, so a second word narrows the result.

| Key | Does |
|---|---|
| `/` | Jump to the text filter |
| `Cmd`/`Ctrl` + `F` | Open the text filter, or close it again |
| `Esc` | Empty the text filter |

`Cmd+F` replaces the browser's find-in-page on this page. That is deliberate: the
browser can only find text already on screen, while this filter searches every PR
on the board.

Order is by how much a PR matters, and the chips on each card are the entire
calculation, so you can disagree with it:

| Part | Points |
|---|---|
| Linear priority | Urgent 40, High 28, Medium 16, Low 6, unset 13 |
| Unblocks another PR of yours | 25 each, capped at 50 |
| Ticket is started (In Progress, In Review, Rollout) | 12 — or 4 if only Todo |
| Days idle | 0.6 a day, capped at 18 |

An unset priority scores just under Medium rather than at the bottom: not setting
one is not the same as saying it does not matter. The age cap keeps an ancient
low-priority PR from outranking an urgent one.

## Sending

Release takes the PR out of draft through GitHub's
`markPullRequestReadyForReview` mutation — REST cannot do it. Reviewers are
requested automatically by the repository's own rules, so this notifies people,
and the app confirms first.

Release one from its card or row, or tick several and release them together. Two
PRs on one ticket are tied together in the gutter and select as a pair, so a
change that has to land in two repositories cannot go out half-done by accident.

For ten seconds afterwards the toast offers **undo**, which converts the PR back
to draft. After that, do it on GitHub.

The release button is the only thing on the page painted in the accent colour. If
there is no magenta on screen, there is nothing to release.

## Desktop notifications

Click the bell in the header once and allow notifications. After that a comment
on one of your PRs raises a desktop notification, and clicking it opens the
comment.

Two authors get through, and nothing else:

- **Bugbot**, so a finding on a PR you have already sent out reaches you.
- **A person** — anyone who is not a bot and is not you.

Every other bot is silent: a walkthrough posted by a review bot is not somebody
asking you for something. Your own comments are silent too.

All of an author's new comments on one PR arrive as a single notification saying
how many, so a review left as five inline notes wakes you once. A conversation
comment, an inline note and a review submitted with a message all count.

The bell mutes for the rest of the session; a reload turns it back on, because
the app stores nothing in the browser. To stop them for good, withdraw the
permission in your browser's site settings.

The first refresh after a start sets the baseline and announces nothing, so
opening the board does not replay a conversation you have already read.

## Setup

**GitHub** — a classic personal access token with the `repo` scope. Fine-grained
tokens cannot use the Search Issues API, so they will not work.

**Linear** — a personal API key, from Settings → Security & access. Optional:
without it you still see every PR, but no ticket, priority, or grouping, and the
Path gate never shuts.

Enter both on the Settings screen, or pin them from outside by uncommenting the
`environment:` block in `docker-compose.yml`. A token supplied that way is used
but never written to the volume, so it stays wherever you put it.

### Why a container and not a file

The first version of this was a single HTML file opened with `file://`. That
worked, but every `file://` page in Chromium shares one `localStorage`
partition — so any other local HTML file you opened could read the tokens. The
container removes that: the browser holds no credential at all.

The server binds to `127.0.0.1` only, refuses cross-origin requests, and
requires `Content-Type: application/json` on writes, so a page you happen to be
visiting cannot drive it.

## How a PR is matched to a ticket

1. The GitHub attachment Linear writes onto the issue — the exact PR URL, and
   the authoritative link.
2. Failing that, the ticket key at the start of the PR title (`[ACME-1200] …`)
   or of the branch (`acme-1200-…`).

A PR with no ticket is shown in its own group rather than hidden.

## Three things that are easy to get wrong

- **`mergeable` lies.** It is computed lazily and reports clean on PRs that are
  actually conflicting. Only `mergeable_state` is trustworthy.
- **Bugbot does not run on drafts.** A missing verdict only means something on a
  PR already out for review, and never in a repository with no CI at all.
- **A "blocked by" relation is spent** once the blocking ticket's PR has merged.

## Development

Requires **pnpm** (`corepack enable pnpm`). The version is pinned in
`package.json`.

```bash
pnpm install     # once
pnpm docker:up   # docker compose up -d --build
pnpm docker:logs # follow the container
pnpm docker:down # stop it
pnpm test        # unit tests: the join, gates, ranking, grouping, token storage
pnpm build       # client bundle + server bundle into dist/
pnpm verify      # full stack, end to end, in a real browser
pnpm fonts       # re-embed the typefaces into src/fonts.css
```

`pnpm verify` is the one that matters. It starts a stand-in for GitHub and
Linear, starts the real server against it, then drives the real page in headless
Chromium: through the setup screen, every lane, and a completed send. It checks
that the send reached the server and that no response ever contains a token.
Screenshots land in `shots/`. Point `FIXTURE` at another capture to use your own
data.

Built with React 19, Tailwind 4 and [shadcn/ui](https://ui.shadcn.com). Add a
component with `npx shadcn@latest add <name>`; it lands in `src/components/ui`
and is yours to edit.

Fonts are embedded as data URIs, so the page makes no external request and looks
the same offline. Geist and Geist Mono are OFL licensed.

### Behind a TLS-inspecting proxy

`pnpm-lock.yaml` names no registry — it records only integrity hashes — so the
same lockfile installs from anywhere. If your network re-signs TLS, the build
container will not trust `registry.npmjs.org`. Point the build at the mirror
your proxy does trust:

```bash
echo 'NPM_REGISTRY=https://your-mirror.example/npm/' > .env
pnpm docker:up
```

`.env` is git-ignored. A pre-commit hook (`scripts/normalize-lockfile.sh`) reads
your mirror from `npm config get registry`, rewrites it back to
`registry.npmjs.org` if it ever reaches a lockfile, and refuses the commit if it
appears in any other staged file. It does nothing if you install from the public
registry.
