/**
 * @jest-environment node
 */
import type { Data, LinearIssue } from "../src/core/types";

const KEY = "lin_test";

function issuePage(hasNextPage: boolean, id: string) {
  return {
    data: {
      issues: {
        pageInfo: { hasNextPage, endCursor: "cursor" },
        nodes: [
          {
            id: `uuid-${id}`,
            identifier: id,
            title: id,
            url: `https://linear.app/x/issue/${id}`,
            priority: 2,
            state: { name: "In Progress", type: "started" },
            project: null,
            parent: null,
            attachments: { nodes: [] },
            inverseRelations: { nodes: [] },
          },
        ],
      },
    },
  };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function boom(status: number): Response {
  return new Response("{}", { status });
}

async function load() {
  jest.resetModules();
  return import("../server/linear");
}

function snapshot(issues: LinearIssue[], at: number): Data {
  return {
    prs: [],
    issues,
    rollups: [],
    alerts: [],
    stateAlerts: [],
    merged: [],
    at,
    login: "me",
    linear: { state: "ok", at },
  };
}

const fetchMock = jest.fn<Promise<Response>, [unknown, unknown]>();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("reaching Linear", () => {
  it("retries a rate limit rather than reporting no issues", async () => {
    fetchMock
      .mockResolvedValueOnce(boom(429))
      .mockResolvedValueOnce(ok(issuePage(false, "ACME-1")));

    const { fetchAssignedIssues } = await load();
    const answer = await fetchAssignedIssues(KEY);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(answer.issues.map((issue) => issue.id)).toEqual(["ACME-1"]);
    expect(answer.complete).toBe(true);
  });

  it("does not retry a rejected key", async () => {
    fetchMock.mockResolvedValue(boom(401));
    const { fetchAssignedIssues } = await load();

    await expect(fetchAssignedIssues(KEY)).rejects.toThrow("Key rejected.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("says the set is incomplete when Linear still has pages", async () => {
    fetchMock.mockImplementation(async () => ok(issuePage(true, "ACME-1")));
    const { fetchAssignedIssues } = await load();

    const answer = await fetchAssignedIssues(KEY);
    expect(answer.complete).toBe(false);
  });
});

describe("the ticket half of a refresh", () => {
  it("keeps the last issues when Linear cannot be reached", async () => {
    fetchMock.mockResolvedValue(boom(500));
    const { fetchTickets } = await load();
    const before = snapshot(
      [
        {
          id: "ACME-1",
          uuid: "uuid-1",
          title: "one",
          url: "u",
          stateName: "In Progress",
          stateType: "started",
          priority: 2,
          blockedBy: [],
          prUrls: [],
        },
      ],
      1000,
    );

    const answer = await fetchTickets(KEY, before);

    expect(answer.issues.map((issue) => issue.id)).toEqual(["ACME-1"]);
    expect(answer.linear.state).toBe("stale");
    expect(answer.linear.at).toBe(1000);
  });

  it("reports missing when there is nothing earlier to fall back to", async () => {
    fetchMock.mockResolvedValue(boom(500));
    const { fetchTickets } = await load();

    const answer = await fetchTickets(KEY, undefined);

    expect(answer.issues).toEqual([]);
    expect(answer.linear.state).toBe("missing");
  });

  it("is off, not broken, without a key", async () => {
    const { fetchTickets } = await load();
    const answer = await fetchTickets(undefined, undefined);

    expect(answer.linear.state).toBe("off");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
