import { buildModel, stacks } from "../src/core/model";
import { buildItem, gatesFor, scoreFor } from "../src/core/rank";
import { canonicalPRUrl, linkPR, buildIssueIndex, prTicketKey, stripTicketPrefix } from "../src/core/link";
import { resolveChecks } from "../server/github";
import type { LinearIssue, PullRequest } from "../src/core/types";

const NOW = new Date("2026-08-26T12:00:00Z").getTime();

let seq = 1;

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: seq,
    nodeId: `NODE_${seq++}`,
    number: 100,
    title: "[ACME-1] A change",
    url: "https://github.com/acme/repo/pull/100",
    owner: "acme",
    repo: "repo",
    createdAt: "2026-08-26T10:00:00Z",
    updatedAt: "2026-08-26T10:00:00Z",
    draft: true,
    approvals: 0,
    changesRequested: 0,
    checks: "success",
    failedChecks: [],
    mergeState: "clean",
    bugbot: "none",
    hasCI: true,
    ...over,
  };
}

function issue(id: string, over: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id,
    title: `${id} title`,
    url: `https://linear.app/${id}`,
    stateName: "In Progress",
    stateType: "started",
    priority: 3,
    blockedBy: [],
    prUrls: [],
    ...over,
  };
}

const ctx = (over = {}) => ({ openTickets: new Set<string>(), unblocks: [], now: NOW, ...over });

describe("ticket keys", () => {
  it("reads a bracketed key from the title", () => {
    expect(prTicketKey(pr())).toBe("ACME-1");
  });

  it("falls back to the branch", () => {
    expect(prTicketKey(pr({ title: "Fix it", headRef: "acme-1391-offload" }))).toBe("ACME-1391");
  });

  it("ignores a key that is not at the start", () => {
    expect(prTicketKey(pr({ title: "Revert the fix for ACME-999", headRef: "revert" }))).toBeNull();
  });

  it("strips the key once it is shown as a badge", () => {
    expect(stripTicketPrefix("[ACME-1391] Stop inflating the payload")).toBe("Stop inflating the payload");
    expect(stripTicketPrefix("acme-953: rename the config key")).toBe("rename the config key");
    expect(stripTicketPrefix("Add a latency report")).toBe("Add a latency report");
  });
});

describe("the join", () => {
  it("prefers Linear's attachment over the title key", () => {
    const index = buildIssueIndex([
      issue("ACME-1"),
      issue("ACME-999", { prUrls: ["https://github.com/acme/repo/pull/100/files"] }),
    ]);
    expect(linkPR(pr(), index)?.id).toBe("ACME-999");
  });

  it("collapses sub-paths when matching an attachment", () => {
    expect(canonicalPRUrl("https://github.com/o/r/pull/5/files?w=1#x")).toBe("o/r#5");
    expect(canonicalPRUrl("https://gitlab.com/o/r/pull/5")).toBeNull();
  });
});

describe("gates", () => {
  it("opens all three on a clean, green, unblocked PR", () => {
    expect(gatesFor(pr(), ctx()).every((gate) => gate.open)).toBe(true);
  });

  it("shuts CI while checks are still running", () => {
    const gates = gatesFor(pr({ checks: "pending" }), ctx());
    expect(gates.find((gate) => gate.name === "ci")!.open).toBe(false);
  });

  it("names the failing check in the reason", () => {
    const gates = gatesFor(pr({ checks: "failure", failedChecks: ["verify-title / check"] }), ctx());
    expect(gates.find((gate) => gate.name === "ci")!.reason).toBe("verify-title / check failed");
    const item = buildItem(pr({ checks: "failure", failedChecks: ["verify-title / check"] }), undefined, new Set(), [], NOW);
    const red = item.signals.find((signal) => signal.kind === "red")!;
    // The pill stays short; the specific check lives in the detail and the gate.
    expect(red.label).toBe("Check failed");
    expect(red.detail).toContain("verify-title / check");
  });

  it("shuts merge on a conflict but not on a merely stale branch", () => {
    expect(gatesFor(pr({ mergeState: "dirty" }), ctx()).find((g) => g.name === "merge")!.open).toBe(false);
    expect(gatesFor(pr({ mergeState: "behind" }), ctx()).find((g) => g.name === "merge")!.open).toBe(true);
  });

  it("shuts path only while the blocking ticket still has an open PR", () => {
    const blocked = issue("ACME-2", { blockedBy: ["ACME-1"] });
    const live = gatesFor(pr(), ctx({ issue: blocked, openTickets: new Set(["ACME-1"]) }));
    expect(live.find((gate) => gate.name === "path")!.open).toBe(false);
    const landed = gatesFor(pr(), ctx({ issue: blocked, openTickets: new Set() }));
    expect(landed.find((gate) => gate.name === "path")!.open).toBe(true);
  });
});

describe("ranking", () => {
  const total = (parts: { points: number }[]) => parts.reduce((sum, part) => sum + part.points, 0);

  it("ranks urgent above high above medium", () => {
    const urgent = total(scoreFor(ctx({ issue: issue("A", { priority: 1 }) }), 0));
    const high = total(scoreFor(ctx({ issue: issue("B", { priority: 2 }) }), 0));
    const medium = total(scoreFor(ctx({ issue: issue("C", { priority: 3 }) }), 0));
    expect(urgent).toBeGreaterThan(high);
    expect(high).toBeGreaterThan(medium);
  });

  it("treats an unset priority as near-medium, not as lowest", () => {
    const none = total(scoreFor(ctx({ issue: issue("A", { priority: 0 }) }), 0));
    const low = total(scoreFor(ctx({ issue: issue("B", { priority: 4 }) }), 0));
    const medium = total(scoreFor(ctx({ issue: issue("C", { priority: 3 }) }), 0));
    expect(none).toBeGreaterThan(low);
    expect(none).toBeLessThan(medium);
  });

  it("lifts a PR that unblocks another", () => {
    const alone = total(scoreFor(ctx({ issue: issue("A") }), 0));
    const unblocking = total(scoreFor(ctx({ issue: issue("A"), unblocks: ["ACME-9"] }), 0));
    expect(unblocking).toBeGreaterThan(alone);
  });

  it("caps the age contribution so an ancient PR cannot outrank an urgent one", () => {
    const ancient = total(scoreFor(ctx({ issue: issue("A", { priority: 4 }) }), 900));
    const urgent = total(scoreFor(ctx({ issue: issue("B", { priority: 1 }) }), 0));
    expect(urgent).toBeGreaterThan(ancient);
  });

  it("explains every point it awards", () => {
    const parts = scoreFor(ctx({ issue: issue("A", { priority: 1 }), unblocks: ["ACME-9"] }), 20);
    expect(parts.map((part) => part.label)).toEqual([
      "Urgent",
      "Unblocks ACME-9",
      "In Progress",
      "Idle 20 days",
    ]);
  });
});

describe("lanes", () => {
  const lane = (over: Partial<PullRequest>, over2 = {}) =>
    buildItem(pr(over), (over2 as any).issue, new Set(), [], NOW).lane;

  it("sends a clean draft", () => expect(lane({})).toBe("send"));
  it("holds a draft with a red check", () => expect(lane({ checks: "failure" })).toBe("held"));
  it("holds a conflicting draft", () => expect(lane({ mergeState: "dirty" })).toBe("held"));
  it("puts a non-draft in flight", () => expect(lane({ draft: false })).toBe("flight"));

  it("puts an approved, green, mergeable PR in the merge lane", () => {
    expect(lane({ draft: false, approvals: 1, mergeState: "clean" })).toBe("merge");
  });

  it("does not ask for Bugbot on a draft or in a repo with no CI", () => {
    const draft = buildItem(pr({ draft: true, bugbot: "none" }), undefined, new Set(), [], NOW);
    expect(draft.signals.some((s) => s.kind === "no_bot")).toBe(false);
    const noCI = buildItem(pr({ draft: false, bugbot: "none", hasCI: false }), undefined, new Set(), [], NOW);
    expect(noCI.signals.some((s) => s.kind === "no_bot")).toBe(false);
    const ready = buildItem(pr({ draft: false, bugbot: "none", hasCI: true }), undefined, new Set(), [], NOW);
    expect(ready.signals.some((s) => s.kind === "no_bot")).toBe(true);
  });
});

describe("a PR two tickets both claim", () => {
  const shared = "https://github.com/acme/repo/pull/100";

  it("belongs to the ticket its own title names, whatever the issue order", () => {
    const parent = issue("ACME-1455", { prUrls: [shared] });
    const child = issue("ACME-1469", { parentId: "ACME-1455", prUrls: [shared] });
    const authored = pr({ title: "[ACME-1469] The child's work", url: shared });

    for (const order of [[parent, child], [child, parent]]) {
      expect(linkPR(authored, buildIssueIndex(order))?.id).toBe("ACME-1469");
    }
  });

  it("still takes Linear's attachment when the title names nothing", () => {
    const parent = issue("ACME-1455", { prUrls: [shared] });
    const untitled = pr({ title: "A change with no ticket", headRef: "seemingly-random", url: shared });

    expect(linkPR(untitled, buildIssueIndex([parent]))?.id).toBe("ACME-1455");
  });
});

describe("what earns a bay", () => {
  const rollup = (live: number, done = 0) => [
    { parentId: "ACME-288", done, canceled: 0, started: live - done, todo: 0, backlog: 0, live },
  ];
  const tree = () => [issue("ACME-288"), issue("ACME-953", { parentId: "ACME-288" })];

  it("gives a real epic its own section on one open PR", () => {
    const model = buildModel([pr({ title: "[ACME-953] The only one open" })], tree(), rollup(4, 2));

    expect(model.bays.map((bay) => bay.key)).toEqual(["ACME-288"]);
    expect(model.singles).toEqual([]);
  });

  it("leaves a parent of one sub-ticket in the ledger", () => {
    const model = buildModel([pr({ title: "[ACME-953] The only one open" })], tree(), rollup(1));

    expect(model.bays).toEqual([]);
    expect(model.singles.map((item) => item.issue?.id)).toEqual(["ACME-953"]);
  });

  it("still earns a bay on two open PRs when no rollup was gathered", () => {
    const model = buildModel(
      [pr({ title: "[ACME-953] One" }), pr({ title: "[ACME-954] Two" })],
      [...tree(), issue("ACME-954", { parentId: "ACME-288" })],
    );

    expect(model.bays.map((bay) => bay.key)).toEqual(["ACME-288"]);
  });
});

describe("nesting", () =>{
  const nested = () => [
    issue("ACME-288"),
    issue("ACME-1455", { parentId: "ACME-288" }),
    issue("ACME-1469", { parentId: "ACME-1455" }),
    issue("ACME-953", { parentId: "ACME-288" }),
  ];

  it("puts a grandchild in its epic's bay, not in a bay of its own", () => {
    const model = buildModel(
      [pr({ title: "[ACME-1469] Deep" }), pr({ title: "[ACME-953] Shallow" })],
      nested(),
    );

    expect(model.bays.map((bay) => bay.key)).toEqual(["ACME-288"]);
    expect(model.bays[0].tickets.map((ticket) => ticket.key).sort()).toEqual([
      "ACME-1469",
      "ACME-953",
    ]);
    expect(model.singles).toEqual([]);
  });

  it("still lets an epic that owns a PR group under itself", () => {
    const model = buildModel(
      [pr({ title: "[ACME-288] The epic's own PR" }), pr({ title: "[ACME-953] A child" })],
      nested(),
    );

    expect(model.bays.map((bay) => bay.key)).toEqual(["ACME-288"]);
    expect(model.bays[0].tickets.map((ticket) => ticket.key).sort()).toEqual([
      "ACME-288",
      "ACME-953",
    ]);
  });

  it("leaves a lone nested PR in the ledger, named for its epic and not its parent", () => {
    const model = buildModel([pr({ title: "[ACME-1469] Alone under the epic" })], nested());

    expect(model.bays).toEqual([]);
    expect(model.singles.map((item) => item.issue?.id)).toEqual(["ACME-1469"]);
    expect(model.singles[0].epicId).toBe("ACME-288");
  });

  it("calls a top-level ticket its own root, so it carries no epic", () => {
    const model = buildModel([pr({ title: "[ACME-288] Standalone" })], nested());

    expect(model.singles[0].epicId).toBeUndefined();
  });
});

describe("stacks", () => {
  const chain = () => {
    const bottom = pr({ number: 1, headRef: "a", baseRef: "main" });
    const middle = pr({ number: 2, headRef: "b", baseRef: "a" });
    const top = pr({ number: 3, headRef: "c", baseRef: "b" });
    return { bottom, middle, top };
  };

  it("reads a chain of three off the branch names, whatever order they arrive in", () => {
    const { bottom, middle, top } = chain();

    const found = stacks([top, bottom, middle]);

    expect(found.get(bottom.id)).toMatchObject({ position: 1, size: 3, parent: undefined });
    expect(found.get(middle.id)).toMatchObject({ position: 2, size: 3, parent: bottom });
    expect(found.get(top.id)).toMatchObject({ position: 3, size: 3, parent: middle });
  });

  it("tags the bottom PR too, which has no parent of its own", () => {
    const { bottom, middle, top } = chain();

    const info = stacks([bottom, middle, top]).get(bottom.id);

    expect(info?.parent).toBeUndefined();
    expect(info?.children).toEqual([middle]);
    expect(info?.size).toBe(3);
  });

  it("counts the whole chain, not just what sits above a PR", () => {
    const { bottom, middle, top } = chain();

    for (const member of [bottom, middle, top]) {
      expect(stacks([bottom, middle, top]).get(member.id)?.size).toBe(3);
    }
  });

  it("gives two PRs off one base the same parent and one stack", () => {
    const base = pr({ number: 1, headRef: "a", baseRef: "main" });
    const left = pr({ number: 2, headRef: "b", baseRef: "a" });
    const right = pr({ number: 3, headRef: "c", baseRef: "a" });

    const found = stacks([base, left, right]);

    expect(found.get(base.id)?.children).toEqual([left, right]);
    expect(found.get(left.id)?.size).toBe(3);
    expect(found.get(right.id)?.parent).toBe(base);
  });

  it("finds a stack whose PRs were all opened against main", () => {
    const bottom = pr({ number: 1, headRef: "a", baseRef: "main", headSha: "aaa", commitShas: ["aaa"] });
    const middle = pr({ number: 2, headRef: "b", baseRef: "main", headSha: "bbb", commitShas: ["aaa", "bbb"] });
    const top = pr({ number: 3, headRef: "c", baseRef: "main", headSha: "ccc", commitShas: ["aaa", "bbb", "ccc"] });

    const found = stacks([top, middle, bottom]);

    expect(found.get(middle.id)?.parent).toBe(bottom);
    expect(found.get(top.id)?.parent).toBe(middle);
    expect(found.get(top.id)?.position).toBe(3);
  });

  it("does not make two branches at the same commit each other's parent", () => {
    const one = pr({ number: 1, headRef: "a", baseRef: "main", headSha: "aaa", commitShas: ["zzz", "aaa"] });
    const two = pr({ number: 2, headRef: "b", baseRef: "main", headSha: "aaa", commitShas: ["zzz", "aaa"] });

    expect(stacks([one, two]).size).toBe(0);
  });

  it("prefers the base branch over the commits when GitHub was told", () => {
    const bottom = pr({ number: 1, headRef: "a", baseRef: "main", headSha: "aaa", commitShas: ["aaa"] });
    const other = pr({ number: 2, headRef: "b", baseRef: "main", headSha: "bbb", commitShas: ["aaa", "bbb"] });
    const top = pr({ number: 3, headRef: "c", baseRef: "a", headSha: "ccc", commitShas: ["aaa", "bbb", "ccc"] });

    expect(stacks([bottom, other, top]).get(top.id)?.parent).toBe(bottom);
  });

  it("does not read a stack across repositories from the commits", () => {
    const one = pr({ repo: "api", headRef: "a", baseRef: "main", headSha: "aaa", commitShas: ["aaa"] });
    const two = pr({ repo: "web", headRef: "b", baseRef: "main", headSha: "bbb", commitShas: ["aaa", "bbb"] });

    expect(stacks([one, two]).size).toBe(0);
  });

  it("does not pair branches of the same name across repositories", () => {
    const one = pr({ repo: "api", headRef: "shared", baseRef: "main" });
    const two = pr({ repo: "web", headRef: "feature", baseRef: "shared" });

    expect(stacks([one, two]).size).toBe(0);
  });

  it("ignores a PR whose base is a branch no open PR owns", () => {
    const solo = pr({ headRef: "feature", baseRef: "main" });

    expect(stacks([solo]).size).toBe(0);
  });

  it("hangs the stack on every item, bottom included", () => {
    const model = buildModel(
      [pr({ number: 1, headRef: "a", baseRef: "main" }), pr({ number: 2, headRef: "b", baseRef: "a" })],
      [],
    );

    expect(model.items.find((item) => item.pr.number === 1)?.stack?.position).toBe(1);
    expect(model.items.find((item) => item.pr.number === 2)?.stack?.position).toBe(2);
  });

  // Stacking is context, not a gate: a stacked PR is perfectly reviewable, and
  // the reviewer usually wants the whole stack at once.
  it("leaves the gates and the lane alone", () => {
    const model = buildModel(
      [pr({ number: 1, headRef: "a", baseRef: "main" }), pr({ number: 2, headRef: "b", baseRef: "a" })],
      [],
    );
    const child = model.items.find((item) => item.pr.number === 2);

    expect(child?.ready).toBe(true);
    expect(child?.lane).toBe("send");
  });
});

describe("buildModel", () => {
  it("orders the release queue on the ladder, best first", () => {
    const model = buildModel(
      [pr({ number: 1, title: "[ACME-10] low" }), pr({ number: 2, title: "[ACME-20] urgent" })],
      [issue("ACME-10", { priority: 4 }), issue("ACME-20", { priority: 1 })],
      [],
      NOW,
    );
    expect(model.queue.map((item) => item.pr.number)).toEqual([2, 1]);
  });

  it("names the nearest draft when nothing is cleared", () => {
    const model = buildModel(
      [
        pr({ number: 1, title: "[ACME-10] conflicting", mergeState: "dirty" }),
        pr({ number: 2, title: "[ACME-20] two problems", mergeState: "dirty", checks: "failure" }),
      ],
      [issue("ACME-10"), issue("ACME-20")],
      [],
      NOW,
    );
    expect(model.queue).toHaveLength(0);
    // One shut gate is nearer than two.
    expect(model.closest?.pr.number).toBe(1);
  });

  it("gives an epic a bay only when it owns more than one open PR", () => {
    const model = buildModel(
      [
        pr({ number: 1, title: "[ACME-11] a" }),
        pr({ number: 2, title: "[ACME-12] b" }),
        pr({ number: 3, title: "[ACME-21] lonely" }),
      ],
      [
        issue("ACME-10"),
        issue("ACME-11", { parentId: "ACME-10" }),
        issue("ACME-12", { parentId: "ACME-10" }),
        issue("ACME-20"),
        issue("ACME-21", { parentId: "ACME-20" }),
      ],
      [],
      NOW,
    );
    expect(model.bays.map((bay) => bay.key)).toEqual(["ACME-10"]);
    // The one-PR epic costs a row, not a section.
    expect(model.singles.map((item) => item.pr.number)).toEqual([3]);
  });

  it("orders bays by epic priority and then id, not by urgency", () => {
    const model = buildModel(
      [
        pr({ number: 1, title: "[ACME-11] a", mergeState: "dirty" }),
        pr({ number: 2, title: "[ACME-12] b", mergeState: "dirty" }),
        pr({ number: 3, title: "[ACME-31] c" }),
        pr({ number: 4, title: "[ACME-32] d" }),
      ],
      [
        issue("ACME-10", { priority: 4 }),
        issue("ACME-11", { parentId: "ACME-10" }),
        issue("ACME-12", { parentId: "ACME-10" }),
        issue("ACME-30", { priority: 1 }),
        issue("ACME-31", { parentId: "ACME-30" }),
        issue("ACME-32", { parentId: "ACME-30" }),
      ],
      [],
      NOW,
    );
    // The urgent epic leads even though the low-priority one is the broken one:
    // the board must not reshuffle as PR states change.
    expect(model.bays.map((bay) => bay.key)).toEqual(["ACME-30", "ACME-10"]);
  });

  it("puts an unprioritised epic last rather than mid-scale", () => {
    const model = buildModel(
      [
        pr({ number: 1, title: "[ACME-11] a" }),
        pr({ number: 2, title: "[ACME-12] b" }),
        pr({ number: 3, title: "[ACME-31] c" }),
        pr({ number: 4, title: "[ACME-32] d" }),
      ],
      [
        issue("ACME-10", { priority: 0 }),
        issue("ACME-11", { parentId: "ACME-10" }),
        issue("ACME-12", { parentId: "ACME-10" }),
        issue("ACME-30", { priority: 4 }),
        issue("ACME-31", { parentId: "ACME-30" }),
        issue("ACME-32", { parentId: "ACME-30" }),
      ],
      [],
      NOW,
    );
    expect(model.bays.map((bay) => bay.key)).toEqual(["ACME-30", "ACME-10"]);
  });

  it("keeps an epic's own PR inside its bay", () => {
    const model = buildModel(
      [pr({ number: 1, title: "[ACME-10] own" }), pr({ number: 2, title: "[ACME-11] child" })],
      [issue("ACME-10"), issue("ACME-11", { parentId: "ACME-10" })],
      [],
      NOW,
    );
    expect(model.bays[0].count).toBe(2);
    expect(model.singles).toHaveLength(0);
  });

  it("keeps one ticket's PRs together across repositories", () => {
    const model = buildModel(
      [
        pr({ number: 1, title: "[ACME-11] infra", repo: "infra" }),
        pr({ number: 2, title: "[ACME-11] fetcher", repo: "s3fetcher" }),
        pr({ number: 3, title: "[ACME-12] other" }),
      ],
      [
        issue("ACME-10"),
        issue("ACME-11", { parentId: "ACME-10" }),
        issue("ACME-12", { parentId: "ACME-10" }),
      ],
      [],
      NOW,
    );
    const ticket = model.bays[0].tickets.find((node) => node.key === "ACME-11")!;
    expect(ticket.items).toHaveLength(2);
    expect(model.bays[0].repos).toBe(3);
  });

  it("separates PRs with no ticket from the singles ledger", () => {
    const model = buildModel(
      [
        pr({ number: 1, title: "Add a skill", headRef: "add-a-skill" }),
        pr({ number: 2, title: "[ACME-99] real work" }),
      ],
      [issue("ACME-99")],
      [],
      NOW,
    );
    expect(model.noTicket.map((item) => item.pr.number)).toEqual([1]);
    expect(model.singles.map((item) => item.pr.number)).toEqual([2]);
  });

  describe("the spine", () => {
    it("shows done cells from the rollup and one cell per open PR", () => {
      const model = buildModel(
        [
          pr({ number: 1, title: "[ACME-11] cleared" }),
          pr({ number: 2, title: "[ACME-12] broken", mergeState: "dirty" }),
          pr({ number: 3, title: "[ACME-13] waiting", draft: false }),
        ],
        [
          issue("ACME-10"),
          issue("ACME-11", { parentId: "ACME-10" }),
          issue("ACME-12", { parentId: "ACME-10" }),
          issue("ACME-13", { parentId: "ACME-10" }),
        ],
        [{ parentId: "ACME-10", done: 2, canceled: 1, started: 3, todo: 0, backlog: 0, live: 5 }],
        NOW,
      );
      expect(model.bays[0].spine).toEqual(["done", "done", "cleared", "needs", "waiting"]);
    });

    it("claims no progress without the rollup", () => {
      const model = buildModel(
        [pr({ number: 1, title: "[ACME-11] a" }), pr({ number: 2, title: "[ACME-12] b" })],
        [issue("ACME-10"), issue("ACME-11", { parentId: "ACME-10" }), issue("ACME-12", { parentId: "ACME-10" })],
        [],
        NOW,
      );
      expect(model.bays[0].spine).not.toContain("done");
      expect(model.bays[0].rollup).toBeUndefined();
    });

    it("marks a dependency-blocked PR apart from a broken one", () => {
      const model = buildModel(
        [pr({ number: 1, title: "[ACME-11] blocker" }), pr({ number: 2, title: "[ACME-12] waiter" })],
        [
          issue("ACME-10"),
          issue("ACME-11", { parentId: "ACME-10" }),
          issue("ACME-12", { parentId: "ACME-10", blockedBy: ["ACME-11"] }),
        ],
        [],
        NOW,
      );
      expect(model.bays[0].spine).toEqual(["cleared", "blocked"]);
    });
  });

  describe("the next move", () => {
    const bay = (prs: PullRequest[], issues: LinearIssue[]) =>
      buildModel(prs, issues, [], NOW).bays[0].move;

    it("prefers merging something approved, and says what it unblocks", () => {
      const move = bay(
        [
          pr({ number: 1, title: "[ACME-11] approved", draft: false, approvals: 1 }),
          pr({ number: 2, title: "[ACME-12] waiter" }),
        ],
        [
          issue("ACME-10"),
          issue("ACME-11", { parentId: "ACME-10" }),
          issue("ACME-12", { parentId: "ACME-10", blockedBy: ["ACME-11"] }),
        ],
      );
      expect(move.kind).toBe("merge");
      expect(move.text).toBe("merge ACME-11 (approved; unblocks ACME-12)");
    });

    it("otherwise releases the best cleared draft", () => {
      const move = bay(
        [
          pr({ number: 1, title: "[ACME-11] cleared", }),
          pr({ number: 2, title: "[ACME-12] broken", mergeState: "dirty" }),
        ],
        [issue("ACME-10"), issue("ACME-11", { parentId: "ACME-10" }), issue("ACME-12", { parentId: "ACME-10" })],
      );
      expect(move.kind).toBe("release");
      expect(move.text).toBe("release ACME-11");
    });

    it("otherwise names the break and its reason", () => {
      const move = bay(
        [
          pr({ number: 1, title: "[ACME-11] broken", checks: "failure", failedChecks: ["go-test"] }),
          pr({ number: 2, title: "[ACME-12] out", draft: false }),
        ],
        [issue("ACME-10"), issue("ACME-11", { parentId: "ACME-10" }), issue("ACME-12", { parentId: "ACME-10" })],
      );
      expect(move.kind).toBe("fix");
      expect(move.text).toBe("ACME-11 — go-test failed");
    });

    it("says plainly when nothing is yours to do", () => {
      const move = bay(
        [
          pr({ number: 1, title: "[ACME-11] out", draft: false }),
          pr({ number: 2, title: "[ACME-12] out", draft: false }),
        ],
        [issue("ACME-10"), issue("ACME-11", { parentId: "ACME-10" }), issue("ACME-12", { parentId: "ACME-10" })],
      );
      expect(move).toEqual({ kind: "waiting", text: "waiting on reviewers — nothing for you" });
    });
  });

  it("sorts rows on the ladder, with a blocked draft below a fixable one", () => {
    const model = buildModel(
      [
        pr({ number: 1, title: "[ACME-11] blocked" }),
        pr({ number: 2, title: "[ACME-12] broken", mergeState: "dirty" }),
        pr({ number: 3, title: "[ACME-13] cleared" }),
        pr({ number: 4, title: "[ACME-14] waiting", draft: false }),
      ],
      [
        issue("ACME-10"),
        issue("ACME-11", { parentId: "ACME-10", blockedBy: ["ACME-13"] }),
        issue("ACME-12", { parentId: "ACME-10" }),
        issue("ACME-13", { parentId: "ACME-10" }),
        issue("ACME-14", { parentId: "ACME-10" }),
      ],
      [],
      NOW,
    );
    const order = model.bays[0].tickets.flatMap((node) => node.items).map((item) => item.pr.number);
    expect(order).toEqual([3, 2, 4, 1]);
  });
});

describe("resolveChecks", () => {
  // Reproduces the real shape: repositories that run only GitHub Actions have
  // no legacy statuses, and the combined-status API reports those as "pending".
  const actionsOnly = (failed: boolean, running: boolean) =>
    resolveChecks("pending", 0, 35, failed, running);

  it("does not read the legacy state when there are no legacy statuses", () => {
    expect(actionsOnly(false, false)).toBe("success");
  });

  it("still reports a failure and a genuinely running check", () => {
    expect(actionsOnly(true, false)).toBe("failure");
    expect(actionsOnly(false, true)).toBe("pending");
  });

  it("reads the legacy state when the commit actually has statuses", () => {
    expect(resolveChecks("pending", 2, 0, false, false)).toBe("pending");
    expect(resolveChecks("failure", 2, 0, false, false)).toBe("failure");
    expect(resolveChecks("success", 2, 0, false, false)).toBe("success");
  });

  it("treats a repository with no CI at all as green", () => {
    expect(resolveChecks("pending", 0, 0, false, false)).toBe("success");
  });
});
