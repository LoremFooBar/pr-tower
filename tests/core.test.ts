import { buildModel, stacks } from "../src/core/model";
import { buildItem, gatesFor, scoreFor, stageOf } from "../src/core/rank";
import { canonicalPRUrl, linkPR, buildIssueIndex, prTicketKey, stripTicketPrefix } from "../src/core/link";
import { authorKind, groupComments, latestPerName, resolveChecks, runState, worstOf } from "../server/github";
import type { RawComment } from "../server/github";
import { noticeFor, unseen } from "../src/core/notify";
import { prLink } from "../src/lib/prhub";
import { nextStages } from "../src/core/search";
import type {
  CommentAlert,
  DeployState,
  DeployStep,
  LinearIssue,
  MergedPR,
  PullRequest,
  Stage,
} from "../src/core/types";
import { blocker, isLive, mergedLine, mergedView, stepLabel } from "../src/core/merged";

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

  // A base branch moves under an approved PR constantly. Reading only `clean`
  // dropped it out of the merge lane, which is the one place it belonged.
  it("keeps an approved PR in the merge lane once its base moves on", () => {
    expect(lane({ draft: false, approvals: 1, mergeState: "behind" })).toBe("merge");
  });

  it("merges through a check that is not required", () => {
    expect(lane({ draft: false, approvals: 1, mergeState: "unstable" })).toBe("merge");
  });

  it("will not call a conflicting or protected PR mergeable", () => {
    expect(lane({ draft: false, approvals: 1, mergeState: "dirty" })).toBe("flight");
    expect(lane({ draft: false, approvals: 1, mergeState: "blocked" })).toBe("flight");
    expect(lane({ draft: false, approvals: 1, mergeState: "unknown" })).toBe("flight");
  });

  it("still needs the approval and a green build", () => {
    expect(lane({ draft: false, approvals: 0, mergeState: "behind" })).toBe("flight");
    expect(lane({ draft: false, approvals: 1, changesRequested: 1, mergeState: "behind" })).toBe("flight");
    expect(lane({ draft: false, approvals: 1, checks: "failure", mergeState: "behind" })).toBe("flight");
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

describe("the filter", () => {
  const board = () =>
    buildModel(
      [
        pr({ number: 412, title: "[ACME-100] Add the rollup endpoint", repo: "billing-api" }),
        pr({ number: 902, title: "[ACME-200] Cache the pricing table", repo: "web" }),
        pr({ number: 77, title: "No ticket here", repo: "worker" }),
      ],
      [issue("ACME-100"), issue("ACME-200")],
    );

  const shown = (query: string) =>
    buildModel(
      board().items.map((item) => item.pr),
      [issue("ACME-100"), issue("ACME-200")],
      [],
      undefined,
      query,
    ).items.map((item) => item.pr.number);

  it("matches a title, a repo, a number and a ticket", () => {
    expect(shown("rollup")).toEqual([412]);
    expect(shown("web")).toEqual([902]);
    expect(shown("#77")).toEqual([77]);
    expect(shown("77")).toEqual([77]);
    expect(shown("acme-200")).toEqual([902]);
  });

  it("narrows on a second token rather than widening", () => {
    expect(shown("cache pricing")).toEqual([902]);
    expect(shown("cache rollup")).toEqual([]);
  });

  it("ignores case and surrounding space", () => {
    expect(shown("  ROLLUP  ")).toEqual([412]);
  });

  it("shows everything when empty", () => {
    expect(shown("").sort((a, b) => a - b)).toEqual([77, 412, 902]);
  });

  it("counts what is hidden, so the header can still say how many there are", () => {
    const model = buildModel(
      board().items.map((item) => item.pr),
      [issue("ACME-100"), issue("ACME-200")],
      [],
      undefined,
      "rollup",
    );

    expect(model.counts.total).toBe(3);
    expect(model.counts.shown).toBe(1);
  });
});

describe("stages", () => {
  // One PR at each of the five stages, all in one board so the counts add up.
  const prs = () => [
    pr({ number: 1, title: "[ACME-1] Ready", draft: true }),
    pr({ number: 2, title: "[ACME-2] Needs you", draft: true, checks: "failure", failedChecks: ["lint"] }),
    pr({ number: 3, title: "[ACME-3] In review", draft: false, bugbot: "success" }),
    pr({ number: 4, title: "[ACME-4] To merge", draft: false, approvals: 1, bugbot: "success" }),
    pr({ number: 5, title: "[ACME-5] Blocked", draft: true }),
  ];
  const issues = () => [
    issue("ACME-1"),
    issue("ACME-2"),
    issue("ACME-3"),
    issue("ACME-4"),
    issue("ACME-5", { blockedBy: ["ACME-1"] }),
  ];

  const at = (stages: Stage[]) =>
    buildModel(prs(), issues(), [], NOW, "", stages)
      .items.map((item) => item.pr.number)
      .sort((a, b) => a - b);

  it("reads one stage off every lane", () => {
    const model = buildModel(prs(), issues(), [], NOW);
    const byNumber = new Map(model.items.map((item) => [item.pr.number, stageOf(item)]));
    expect(byNumber.get(1)).toBe("ready");
    expect(byNumber.get(2)).toBe("needs");
    expect(byNumber.get(3)).toBe("review");
    expect(byNumber.get(4)).toBe("merge");
    expect(byNumber.get(5)).toBe("blocked");
  });

  it("tells blocked apart from needs you, because there is nothing to do yet", () => {
    expect(at(["needs"])).toEqual([2]);
    expect(at(["blocked"])).toEqual([5]);
  });

  it("widens on a second stage rather than narrowing", () => {
    expect(at(["ready", "merge"])).toEqual([1, 4]);
  });

  it("shows the whole board when nothing is picked", () => {
    expect(at([])).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the total honest about what is hidden", () => {
    const model = buildModel(prs(), issues(), [], NOW, "", ["review"]);
    expect(model.counts.total).toBe(5);
    expect(model.counts.shown).toBe(1);
  });

  it("counts every stage even while one is picked, so a chip does not zero out", () => {
    const model = buildModel(prs(), issues(), [], NOW, "", ["review"]);
    expect(model.stageCounts).toEqual({ merge: 1, ready: 1, needs: 1, review: 1, blocked: 1 });
  });

  it("counts the stages within the text query, not across the whole board", () => {
    const model = buildModel(prs(), issues(), [], NOW, "acme-3");
    expect(model.stageCounts).toEqual({ merge: 0, ready: 0, needs: 0, review: 1, blocked: 0 });
  });

  it("combines with the text query rather than replacing it", () => {
    expect(buildModel(prs(), issues(), [], NOW, "acme-3", ["review"]).items).toHaveLength(1);
    expect(buildModel(prs(), issues(), [], NOW, "acme-3", ["ready"]).items).toHaveLength(0);
  });

  it("narrows what is shown, never what is known", () => {
    // ACME-5 is hidden, and still spends the blocker it owns: ACME-1 keeps the
    // credit for unblocking it, so the ranking does not move under the filter.
    const all = buildModel(prs(), issues(), [], NOW);
    const filtered = buildModel(prs(), issues(), [], NOW, "", ["ready"]);
    const score = (model: typeof all) =>
      model.items.find((item) => item.pr.number === 1)?.score;
    expect(score(filtered)).toBe(score(all));
    expect(filtered.items[0].unblocks).toEqual(["ACME-5"]);
  });

  it("counts a bay by stage, in the same words the chips use", () => {
    const model = buildModel(
      [
        pr({ number: 1, title: "[ACME-11] Ready" }),
        pr({ number: 2, title: "[ACME-12] In review", draft: false, bugbot: "success" }),
      ],
      [
        issue("ACME-10"),
        issue("ACME-11", { parentId: "ACME-10" }),
        issue("ACME-12", { parentId: "ACME-10" }),
      ],
      [],
      NOW,
    );
    expect(model.bays[0].stages).toEqual({ merge: 0, ready: 1, needs: 0, review: 1, blocked: 0 });
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

describe("latestPerName", () => {
  // The real shape from template-runner#606: one workflow triggered three times
  // on one commit, so three suites each contributed a run of the same name.
  const runs = [
    { id: 101353299800, name: "app-client / build-and-publish", status: "completed", conclusion: "success", started_at: "2026-09-05T18:19:22Z" },
    { id: 101353214168, name: "app-client / build-and-publish", status: "completed", conclusion: "success", started_at: "2026-09-05T18:18:46Z" },
    { id: 101353212743, name: "app-client / build-and-publish", status: "completed", conclusion: "failure", started_at: "2026-09-05T18:18:46Z" },
    { id: 101353207610, name: "build-and-push-image / build", status: "completed", conclusion: "success", started_at: "2026-09-05T18:19:48Z" },
  ];

  it("keeps only the newest run of each name", () => {
    const kept = latestPerName(runs);
    expect(kept).toHaveLength(2);
    expect(kept.find((run) => run.name?.startsWith("app-client"))?.conclusion).toBe("success");
  });

  it("breaks a tie on start time by id", () => {
    const tied = runs.filter((run) => run.started_at === "2026-09-05T18:18:46Z");
    expect(latestPerName(tied)[0].id).toBe(101353214168);
  });

  it("leaves distinct names alone", () => {
    expect(latestPerName(runs.slice(0, 1).concat(runs[3]))).toHaveLength(2);
  });
});

describe("who is worth a notification", () => {
  it("names Bugbot however its account is spelled", () => {
    expect(authorKind("cursor[bot]", "Bot", "me")).toBe("bugbot");
    expect(authorKind("bugbot[bot]", "Bot", "me")).toBe("bugbot");
  });

  it("drops every other bot", () => {
    expect(authorKind("coderabbitai[bot]", "Bot", "me")).toBeNull();
    expect(authorKind("dependabot", "Bot", "me")).toBeNull();
  });

  it("drops the reader's own comments", () => {
    expect(authorKind("me", "User", "me")).toBeNull();
  });

  it("keeps a person named cursor a person", () => {
    expect(authorKind("cursor", "User", "me")).toBe("person");
  });
});

describe("grouping comments", () => {
  const SINCE = "2026-08-26T11:00:00Z";

  function target(over: Partial<PullRequest> = {}): PullRequest {
    return pr({ owner: "acme", repo: "web", number: 888, title: "[ACME-1] A change", ...over });
  }

  function comment(over: Partial<RawComment> = {}): RawComment {
    return {
      surface: "issue",
      id: 1,
      html_url: "https://github.com/acme/web/pull/888#comment-1",
      body: "Have another look at the retry path.",
      created_at: "2026-08-26T11:30:00Z",
      user: { login: "dana", type: "User" },
      issue_url: "https://api.github.com/repos/acme/web/issues/888",
      ...over,
    };
  }

  it("collapses one author's comments on one PR into a single arrival", () => {
    const { alerts, keys } = groupComments(
      [
        comment(),
        comment({ surface: "inline", id: 2, created_at: "2026-08-26T11:40:00Z", body: "And here." }),
      ],
      [target()],
      "me",
      SINCE,
      new Set(),
    );

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ author: "dana", kind: "person", count: 2, number: 888 });
    // The newest of the group, so the link lands on the latest thing said.
    expect(alerts[0].id).toBe("inline:2");
    expect(keys.sort()).toEqual(["inline:2", "issue:1"]);
  });

  it("keeps two authors on one PR apart", () => {
    const { alerts } = groupComments(
      [comment(), comment({ id: 2, user: { login: "cursor[bot]", type: "Bot" } })],
      [target()],
      "me",
      SINCE,
      new Set(),
    );

    expect(alerts.map((alert) => alert.kind).sort()).toEqual(["bugbot", "person"]);
  });

  it("says nothing twice", () => {
    const { alerts, keys } = groupComments([comment()], [target()], "me", SINCE, new Set(["issue:1"]));
    expect(alerts).toEqual([]);
    expect(keys).toEqual([]);
  });

  it("ignores a comment edited long after it was written", () => {
    const { alerts } = groupComments(
      [comment({ created_at: "2026-08-20T09:00:00Z" })],
      [target()],
      "me",
      SINCE,
      new Set(),
    );
    expect(alerts).toEqual([]);
  });

  it("ignores a comment on something that is not one of the PRs in hand", () => {
    const { alerts } = groupComments(
      [comment({ issue_url: "https://api.github.com/repos/acme/web/issues/4001" })],
      [target()],
      "me",
      SINCE,
      new Set(),
    );
    expect(alerts).toEqual([]);
  });

  it("strips the markdown and the metadata Bugbot wraps a finding in", () => {
    const { alerts } = groupComments(
      [
        comment({
          user: { login: "cursor[bot]", type: "Bot" },
          body:
            "### Scan fails open past the depth cap\n\n**Medium Severity**\n\n" +
            "`walk` returns early, so a deeper tree reports clean.\n<!-- bugbot-meta: 1 -->",
        }),
      ],
      [target()],
      "me",
      SINCE,
      new Set(),
    );
    expect(alerts[0].excerpt).toBe(
      "Scan fails open past the depth cap Medium Severity walk returns early, so a deeper tree reports clean.",
    );
  });

  it("drops a metadata block that was never closed", () => {
    const { alerts } = groupComments(
      [comment({ body: "Have another look.\n<!-- bugbot-meta" })],
      [target()],
      "me",
      SINCE,
      new Set(),
    );
    expect(alerts[0].excerpt).toBe("Have another look.");
  });

  it("flattens the body into an excerpt", () => {
    const { alerts } = groupComments(
      [comment({ body: "  Bug: the tenant id\n\nis dropped   here.  " })],
      [target()],
      "me",
      SINCE,
      new Set(),
    );
    expect(alerts[0].excerpt).toBe("Bug: the tenant id is dropped here.");
  });
});

describe("picking a stage", () => {
  const set = (...stages: Stage[]) => new Set<Stage>(stages);
  const sorted = (s: Set<Stage>) => [...s].sort();

  it("keeps only the stage clicked", () => {
    expect(sorted(nextStages(set(), "ready", false))).toEqual(["ready"]);
    expect(sorted(nextStages(set("review"), "ready", false))).toEqual(["ready"]);
    expect(sorted(nextStages(set("review", "blocked"), "ready", false))).toEqual(["ready"]);
  });

  it("turns the last one off again, so the whole board is one click away", () => {
    expect(sorted(nextStages(set("ready"), "ready", false))).toEqual([]);
  });

  it("keeps a plain click on one of several as a narrowing, not a clearing", () => {
    expect(sorted(nextStages(set("ready", "review"), "ready", false))).toEqual(["ready"]);
  });

  it("adds and removes when the modifier is held", () => {
    expect(sorted(nextStages(set("ready"), "review", true))).toEqual(["ready", "review"]);
    expect(sorted(nextStages(set("ready", "review"), "review", true))).toEqual(["ready"]);
  });

  it("leaves nothing selected when the modifier removes the last one", () => {
    expect(sorted(nextStages(set("ready"), "ready", true))).toEqual([]);
  });

  it("does not mutate the set it was given", () => {
    const current = set("ready");
    nextStages(current, "review", true);
    expect(sorted(current)).toEqual(["ready"]);
  });
});

describe("what the desktop is told", () => {
  function alert(over: Partial<CommentAlert> = {}): CommentAlert {
    return {
      id: "issue:1",
      prId: 1,
      repo: "web",
      number: 888,
      title: "[ACME-1] Tighten the session refresh window",
      url: "https://github.com/acme/web/pull/888#comment-1",
      author: "dana",
      kind: "person",
      count: 1,
      excerpt: "Have another look at the retry path.",
      at: "2026-08-26T11:30:00Z",
      ...over,
    };
  }

  it("names the person and the PR", () => {
    expect(noticeFor(alert()).title).toBe("dana commented on web #888");
  });

  it("counts a burst", () => {
    expect(noticeFor(alert({ count: 3 })).title).toBe("dana commented on web #888 (3)");
  });

  it("calls Bugbot Bugbot, not by its account", () => {
    expect(noticeFor(alert({ kind: "bugbot", author: "cursor[bot]" })).title).toBe(
      "Bugbot commented on web #888",
    );
  });

  it("falls back to the PR title when the comment has no text", () => {
    expect(noticeFor(alert({ excerpt: "" })).body).toBe("Tighten the session refresh window");
  });

  it("shares one tag per arrival, so two open windows raise one notification", () => {
    expect(noticeFor(alert()).tag).toBe("issue:1");
  });

  it("passes over what has already been raised", () => {
    expect(unseen([alert(), alert({ id: "issue:2" })], new Set(["issue:1"]))).toHaveLength(1);
  });
});

describe("opening a PR without the PR Hub extension", () => {
  // prLink only reads these four fields off the event.
  function click(over: Partial<MouseEvent> = {}) {
    return {
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: jest.fn(),
      ...over,
    } as unknown as Parameters<ReturnType<typeof prLink>["onClick"]>[0] & {
      preventDefault: jest.Mock;
    };
  }

  const URL = "https://github.com/acme/web/pull/888";

  function mark(installed: boolean) {
    if (installed) document.documentElement.dataset.prHub = "1";
    else delete document.documentElement.dataset.prHub;
  }

  let posted: unknown[] = [];
  const listener = (event: MessageEvent) => posted.push(event.data);

  beforeEach(() => {
    posted = [];
    window.addEventListener("message", listener);
  });

  afterEach(() => {
    window.removeEventListener("message", listener);
    mark(false);
  });

  it("is a real GitHub link whether or not the extension is there", () => {
    for (const installed of [false, true]) {
      mark(installed);
      expect(prLink(URL)).toMatchObject({ href: URL, target: "_blank", rel: "noreferrer" });
    }
  });

  it("lets the browser have the click when the extension is absent", () => {
    mark(false);
    const event = click();
    prLink(URL).onClick(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("posts nothing when the extension is absent", async () => {
    mark(false);
    prLink(URL).onClick(click());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posted).toEqual([]);
  });

  it("hands the click to the extension only once the page is marked", async () => {
    mark(true);
    const event = click();
    prLink(URL).onClick(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(posted).toEqual([{ type: "prhub:open-pr", url: URL }]);
  });

  it("leaves a modified click to the browser even with the extension", () => {
    mark(true);
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const event = click(modifier);
      prLink(URL).onClick(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  });
});

describe("merged pull requests", () => {
  const step = (state: DeployState, name = "deploy"): DeployStep => ({
    kind: "workflow",
    name,
    state,
  });

  function merged(over: Partial<MergedPR> = {}): MergedPR {
    return {
      id: Math.random(),
      number: 100,
      title: "[ACME-1] A change",
      url: "https://github.com/acme/web/pull/100",
      owner: "acme",
      repo: "web",
      mergedAt: "2026-08-26T10:00:00Z",
      mergeSha: "abc",
      steps: [step("ok")],
      state: "ok",
      ...over,
    };
  }

  describe("the worst step decides the row", () => {
    it("takes the most urgent state present", () => {
      expect(worstOf([step("ok"), step("failed"), step("running")])).toBe("failed");
      expect(worstOf([step("ok"), step("running")])).toBe("running");
      expect(worstOf([step("ok"), step("waiting"), step("running")])).toBe("waiting");
      expect(worstOf([step("ok"), step("ok")])).toBe("ok");
    });

    it("says nothing ran rather than guessing", () => {
      expect(worstOf([])).toBe("none");
    });
  });

  describe("reading a workflow run", () => {
    const run = (over: object) => ({ id: 1, status: "completed", conclusion: null, ...over });

    it("calls an approval gate waiting, because a person has to act", () => {
      expect(runState(run({ status: "waiting" }))).toBe("waiting");
    });

    it("calls anything unfinished running", () => {
      expect(runState(run({ status: "in_progress" }))).toBe("running");
      expect(runState(run({ status: "queued" }))).toBe("running");
    });

    it("reads success and the harmless conclusions as done", () => {
      expect(runState(run({ conclusion: "success" }))).toBe("ok");
      expect(runState(run({ conclusion: "skipped" }))).toBe("ok");
    });

    // A cancelled run is almost always one a later merge superseded, so it is
    // read as done here and resolved against the newer run by the caller.
    it("does not call a cancelled run a failure", () => {
      expect(runState(run({ conclusion: "cancelled" }))).toBe("ok");
    });

    it("calls everything else failed", () => {
      expect(runState(run({ conclusion: "failure" }))).toBe("failed");
      expect(runState(run({ conclusion: "timed_out" }))).toBe("failed");
    });
  });

  describe("the order", () => {
    it("puts anything still moving above anything finished", () => {
      const view = mergedView(
        [
          merged({ number: 1, state: "ok", mergedAt: "2026-08-26T12:00:00Z" }),
          merged({ number: 2, state: "running", mergedAt: "2026-08-26T09:00:00Z" }),
          merged({ number: 3, state: "failed", mergedAt: "2026-08-26T08:00:00Z" }),
          merged({ number: 4, state: "waiting", mergedAt: "2026-08-26T07:00:00Z" }),
        ],
        "",
      );
      expect(view.map((pr) => pr.number)).toEqual([3, 4, 2, 1]);
    });

    it("orders newest first within a band", () => {
      const view = mergedView(
        [
          merged({ number: 1, state: "ok", mergedAt: "2026-08-20T10:00:00Z" }),
          merged({ number: 2, state: "ok", mergedAt: "2026-08-26T10:00:00Z" }),
        ],
        "",
      );
      expect(view.map((pr) => pr.number)).toEqual([2, 1]);
    });

    it("answers the same text filter the rest of the page does", () => {
      const rows = [
        merged({ number: 1, title: "[ACME-1] Cache the pricing table", repo: "web" }),
        merged({ number: 2, title: "[ACME-2] Bound the retry queue", repo: "worker" }),
      ];
      expect(mergedView(rows, "pricing").map((pr) => pr.number)).toEqual([1]);
      expect(mergedView(rows, "worker").map((pr) => pr.number)).toEqual([2]);
      expect(mergedView(rows, "#2").map((pr) => pr.number)).toEqual([2]);
      expect(mergedView(rows, "acme-1").map((pr) => pr.number)).toEqual([1]);
    });
  });

  describe("the collapsed line", () => {
    it("says the window when nothing merged, so a broken fetch is visible", () => {
      expect(mergedLine([], 7)).toBe("Nothing merged in the last 7 days");
      expect(mergedLine([], 1)).toBe("Nothing merged in the last 1 day");
    });

    it("says all live when there is nothing to do", () => {
      expect(mergedLine([merged(), merged()], 7)).toBe("2 merged · all live");
    });

    it("leads with the failure and names where it failed", () => {
      const line = mergedLine(
        [
          merged({ number: 5, state: "failed", steps: [step("failed", "production")] }),
          merged(),
        ],
        7,
      );
      expect(line).toBe("deploy failed — web #5 production · 1 live");
    });

    it("names an approval gate as waiting rather than failed", () => {
      const line = mergedLine(
        [merged({ number: 6, state: "waiting", steps: [step("waiting", "global")] })],
        7,
      );
      expect(line).toBe("waiting for approval — web #6 global");
    });

    it("counts the rest that are not live", () => {
      const line = mergedLine(
        [
          merged({ number: 5, state: "failed", steps: [step("failed", "production")] }),
          merged({ number: 6, state: "running", steps: [step("running", "staging")] }),
          merged({ number: 7 }),
        ],
        7,
      );
      expect(line).toBe("deploy failed — web #5 production · 1 more not live · 1 live");
    });
  });

  describe("what counts as live", () => {
    it("treats a PR whose workflows never ran as nothing to chase", () => {
      expect(isLive(merged({ state: "none", steps: [] }))).toBe(true);
    });

    it("does not call a waiting PR live", () => {
      expect(isLive(merged({ state: "waiting" }))).toBe(false);
    });

    it("names the step the row is stuck on", () => {
      const pr = merged({
        state: "failed",
        steps: [step("ok", "build"), step("failed", "production")],
      });
      expect(blocker(pr)?.name).toBe("production");
    });
  });
});

describe("what a step is called", () => {
  const label = (name: string, kind: DeployStep["kind"] = "workflow") =>
    stepLabel({ kind, name, state: "ok" });

  it("leaves an environment alone", () => {
    expect(label("production", "environment")).toBe("production");
  });

  it("drops the words every pipeline is called", () => {
    expect(label("Main CI/CD Pipeline")).toBe("Main CI/CD");
    expect(label("Main content Deployment Pipeline")).toBe("Main content");
  });

  it("drops a trailing run number, which the link already carries", () => {
    expect(label("Configured Graph Update: go_modules in /. #1559439343")).not.toMatch(/1559439343/);
  });

  // Dependabot names a run after its own commit message.
  it("cuts a generated name before it takes the row", () => {
    const cut = label(
      "go_modules in /investigation-templates/.ci for google.golang.org/grpc - Update #1551702762",
    );
    expect(cut.length).toBeLessThanOrEqual(28);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("keeps a name a person wrote", () => {
    expect(label("Template Reference Check")).toBe("Template Reference Check");
  });

  it("never returns nothing, however much it strips", () => {
    expect(label("Deploy")).toBe("Deploy");
  });
});

describe("merged PRs under their ticket", () => {
  const shipped = (over: Partial<MergedPR>): MergedPR => ({
    id: Math.random(),
    number: 1,
    title: "[ACME-1] Shipped",
    url: "https://github.com/acme/web/pull/1",
    owner: "acme",
    repo: "web",
    mergedAt: "2026-08-20T10:00:00Z",
    mergeSha: "abc",
    steps: [],
    state: "ok",
    ...over,
  });

  const board = (merged: MergedPR[]) =>
    buildModel(
      [pr({ number: 10, title: "[ACME-1] Still open" })],
      [issue("ACME-1")],
      [],
      NOW,
      "",
      [],
      merged,
    );

  it("attaches a merged PR to the ticket that is on the board", () => {
    const model = board([shipped({ number: 9, issueKey: "ACME-1" })]);
    expect(model.mergedByTicket.get("ACME-1")?.map((m) => m.number)).toEqual([9]);
  });

  it("matches the ticket whatever case it was written in", () => {
    const model = board([shipped({ number: 9, issueKey: "acme-1" })]);
    expect(model.mergedByTicket.get("ACME-1")?.map((m) => m.number)).toEqual([9]);
  });

  // A ticket whose PRs have all merged is finished; its progress is the
  // rollup's business, and a bay for it would be a section about nothing.
  it("drops a merged PR whose ticket has nothing open", () => {
    const model = board([shipped({ number: 9, issueKey: "ACME-999" })]);
    expect(model.mergedByTicket.size).toBe(0);
  });

  it("drops a merged PR with no ticket at all", () => {
    const model = board([shipped({ number: 9, issueKey: undefined })]);
    expect(model.mergedByTicket.size).toBe(0);
  });

  it("puts the newest first under one ticket", () => {
    const model = board([
      shipped({ number: 8, issueKey: "ACME-1", mergedAt: "2026-08-18T10:00:00Z" }),
      shipped({ number: 9, issueKey: "ACME-1", mergedAt: "2026-08-24T10:00:00Z" }),
    ]);
    expect(model.mergedByTicket.get("ACME-1")?.map((m) => m.number)).toEqual([9, 8]);
  });
});
