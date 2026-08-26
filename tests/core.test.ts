import { buildModel } from "../src/core/model";
import { buildItem, gatesFor, scoreFor } from "../src/core/rank";
import { canonicalPRUrl, linkPR, buildIssueIndex, prTicketKey, stripTicketPrefix } from "../src/core/link";
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

describe("buildModel", () => {
  it("orders the send queue by score, best first", () => {
    const model = buildModel(
      [
        pr({ number: 1, title: "[ACME-10] low" }),
        pr({ number: 2, title: "[ACME-20] urgent" }),
      ],
      [issue("ACME-10", { priority: 4 }), issue("ACME-20", { priority: 1 })],
      NOW,
    );
    expect(model.queue.map((item) => item.pr.number)).toEqual([2, 1]);
  });

  it("credits a PR for unblocking another that still has an open PR", () => {
    const model = buildModel(
      [pr({ number: 1, title: "[ACME-10] blocker" }), pr({ number: 2, title: "[ACME-20] waiter" })],
      [issue("ACME-10"), issue("ACME-20", { blockedBy: ["ACME-10"] })],
      NOW,
    );
    const blocker = model.items.find((item) => item.pr.number === 1)!;
    expect(blocker.unblocks).toEqual(["ACME-20"]);
    expect(blocker.scoreParts.some((part) => part.label === "Unblocks ACME-20")).toBe(true);

    const waiter = model.items.find((item) => item.pr.number === 2)!;
    expect(waiter.lane).toBe("held");
  });

  it("does not credit unblocking a ticket that has no open PR", () => {
    const model = buildModel(
      [pr({ number: 1, title: "[ACME-10] blocker" })],
      [issue("ACME-10"), issue("ACME-20", { blockedBy: ["ACME-10"] })],
      NOW,
    );
    expect(model.items[0].unblocks).toEqual([]);
  });

  it("keeps an epic's own PR in the epic's group", () => {
    const model = buildModel(
      [pr({ number: 1, title: "[ACME-288] own" }), pr({ number: 2, title: "[ACME-1384] child" })],
      [issue("ACME-288"), issue("ACME-1384", { parentId: "ACME-288" })],
      NOW,
    );
    const epic = model.groups.find((group) => group.key === "ACME-288")!;
    expect(epic.count).toBe(2);
    expect(model.groups.some((group) => group.key === " no-parent")).toBe(false);
  });

  it("keeps one ticket's PRs together across repositories", () => {
    const model = buildModel(
      [
        pr({ number: 1, title: "[ACME-1115] infra", repo: "infra" }),
        pr({ number: 2, title: "[ACME-1115] fetcher", repo: "s3fetcher" }),
      ],
      [issue("ACME-1115")],
      NOW,
    );
    expect(model.groups[0].tickets).toHaveLength(1);
    expect(model.groups[0].repos).toBe(2);
  });
});
