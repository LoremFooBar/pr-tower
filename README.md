# PR Tower

One HTML file that ranks your open pull requests and sends the ready ones out
for review.

Open `dist/index.html` in a browser. There is no server, no container, and no
install — the page talks straight to GitHub and Linear from your browser, and
your keys never leave it.

```bash
npm install && npm run build
open dist/index.html          # macOS
```

## What it does

**Ready to send** is the point of the app. It lists the drafts that could go out
right now, most important first, with a Send for review button on each and a
checkbox for sending several at once.

A draft is ready when all three gates are open:

| Gate | Shut when |
|---|---|
| **CI** | A check failed, or checks are still running |
| **Merge** | The branch conflicts with its base |
| **Path** | Linear says the ticket is blocked by another ticket that still has an open PR of yours |

These three are deliberately the whole list. They are the conditions under which
asking someone to review would waste their time. Being behind the base branch,
or idle for a month, does not stop a review — those show as context instead.

Order is by how much a PR matters, and the chips under each row are the entire
calculation, so you can disagree with it:

| Part | Points |
|---|---|
| Linear priority | Urgent 40, High 28, Medium 16, Low 6, unset 13 |
| Unblocks another PR of yours | 25 each, capped at 50 |
| Ticket is started (In Progress, In Review, Rollout) | 12 — or 4 if only Todo |
| Days idle | 0.6 a day, capped at 18 |

An unset priority scores just under Medium rather than at the bottom: not
setting one is not the same as saying it does not matter. The age cap keeps an
ancient low-priority PR from outranking an urgent one.

**Held back** shows the drafts with a gate shut, nearest to ready first, each
naming the one thing in the way.

**Out for review** is what you are waiting on other people for, with anything
already approved pulled to the top.

**Everything** groups every open PR under its Linear sub-ticket and parent epic.
A ticket owning several PRs across repositories keeps them together.

## Sending

Send takes the PR out of draft through GitHub's `markPullRequestReadyForReview`
mutation — REST cannot do it. Reviewers are requested automatically by the
repository's own rules, so this notifies people, and the app confirms before it
sends. It is reversible: convert back to draft on GitHub.

## Setup

**GitHub** — a classic personal access token with the `repo` scope. Fine-grained
tokens cannot use the Search Issues API, so they will not work.

**Linear** — a personal API key, from Settings → Security & access. Optional:
without it you still see every PR, but no ticket, priority, or grouping, and the
Path gate never shuts.

Both live in this browser's `localStorage` and are sent only to
`api.github.com` and `api.linear.app`. Keys clears them.

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

```bash
npm run dev       # Vite dev server
npm test          # unit tests for the join, gates, ranking, and grouping
npm run build     # single self-contained file → dist/index.html
npm run verify    # loads the built file from file:// and drives it end to end
npm run fonts     # re-embed the typefaces into src/fonts.css
```

`npm run verify` opens the built file in headless Chromium with a canned GitHub
and Linear fixture, screenshots every view into `shots/`, and completes a send
to check the write path. Point `FIXTURE` at another capture to use your own
data. It is the only way to test that the file works with no server, since that
is exactly how it is used.

Fonts are embedded as data URIs, so the page makes no external request and looks
the same offline. Chivo and Chivo Mono are OFL licensed.
