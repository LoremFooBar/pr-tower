// Stands in for GitHub and Linear so the real server can be driven end to end
// without credentials or network. Serves the same fixture the browser test uses.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(process.env.FIXTURE ?? resolve(here, "fixture.demo.json"), "utf8"),
);

// Comment ids come from three sequences at GitHub and from one here, which is
// enough: the server qualifies each id with the surface it arrived on.
let commentId = 1000;

const json = (res, body) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  if (path === "/linear") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const query = JSON.parse(body || "{}").query ?? "";
    if (query.includes("viewer")) return json(res, { data: { viewer: { name: "Tester" } } });
    if (query.includes("Children")) {
      return json(res, { data: { issues: { nodes: fixture.children ?? [] } } });
    }
    return json(res, {
      data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: fixture.issues } },
    });
  }

  if (path === "/graphql") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const query = JSON.parse(body || "{}").query ?? "";
    // Answer with the field that was actually asked for, and with the draft
    // flag that mutation is supposed to leave behind.
    const toDraft = query.includes("convertPullRequestToDraft");
    const field = toDraft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
    return json(res, { data: { [field]: { pullRequest: { number: 1, isDraft: toDraft } } } });
  }

  // The server inlines a reviewer's avatar, and it fetches whatever URL the
  // review carried — so the fixture points it here rather than at the internet.
  if (path.startsWith("/avatar/")) {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(readFileSync(resolve(here, "fixture-avatar.png")));
  }

  if (path === "/user") return json(res, fixture.user);
  if (path === "/search/issues") return json(res, { items: fixture.items });

  let m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
  if (m) return json(res, fixture.details[`${m[1]}/${m[2]}/${m[3]}`] ?? {});

  m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews$/);
  if (m) {
    const rows = fixture.reviews[`${m[1]}/${m[2]}/${m[3]}`] ?? [];
    // A review submitted with a message is also a comment, and the server reads
    // its timestamp against the last sweep — stamped on the way out so every
    // sweep sees it as new, however many have run before.
    return json(
      res,
      rows.map((row) => {
        if (!row.body) return row;
        const id = ++commentId;
        return {
          ...row,
          id,
          submitted_at: new Date().toISOString(),
          html_url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}#pullrequestreview-${id}`,
        };
      }),
    );
  }

  // Both comment surfaces answer per repository, which is why a sweep costs two
  // calls however many open PRs the repository holds. The `since` filter is
  // ignored here for the same reason the reviews above are restamped.
  m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/comments$/);
  if (m) {
    const repo = `${m[1]}/${m[2]}`;
    const rows = fixture.comments?.[m[3]]?.[repo] ?? [];
    const field = m[3] === "issues" ? "issue_url" : "pull_request_url";
    return json(
      res,
      rows.map((row) => {
        const id = ++commentId;
        const at = new Date().toISOString();
        return {
          id,
          html_url: `https://github.com/${repo}/pull/${row.target}#comment-${id}`,
          body: row.body,
          created_at: at,
          updated_at: at,
          user: { login: row.login, type: row.type },
          [field]: `http://localhost:5179/repos/${repo}/${m[3]}/${row.target}`,
        };
      }),
    );
  }

  // Oldest first, like GitHub, and relative to the PR's base — which is why a
  // child in a declared stack lists none of its parent's commits.
  m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/commits$/);
  if (m) {
    const shas = fixture.commits?.[`${m[1]}/${m[2]}/${m[3]}`] ?? [];
    return json(res, shas.map((sha) => ({ sha })));
  }

  m = path.match(/^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]+)\/status$/);
  // Matches reality: Actions-only repositories have no legacy statuses, and
  // the combined-status API calls that "pending".
  if (m) return json(res, { state: "pending", total_count: 0 });

  m = path.match(/^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]+)\/check-runs$/);
  if (m) return json(res, fixture.checkruns[m[1]] ?? { total_count: 0, check_runs: [] });

  json(res, {});
}).listen(5179, () => console.log("mock upstream on 5179"));
