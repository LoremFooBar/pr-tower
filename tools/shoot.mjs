// Loads the built single file from file://, replays a captured GitHub + Linear
// fixture through the real fetch paths, and screenshots each view. This is the
// only way to check that the file works with no server and no build step.
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const fixture = JSON.parse(
  readFileSync(process.env.FIXTURE ?? resolve(here, "fixture.demo.json"), "utf8"),
);
const out = resolve(root, "shots");
mkdirSync(out, { recursive: true });

const theme = process.argv[2] ?? "dark";

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1180, height: 1000 },
  colorScheme: theme,
  deviceScaleFactor: 2,
});

const json = (body) => ({
  status: 200,
  contentType: "application/json",
  headers: { "access-control-allow-origin": "*" },
  body: JSON.stringify(body),
});

await page.route("https://api.github.com/**", (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname;
  if (path === "/user") return route.fulfill(json(fixture.user));
  if (path === "/search/issues") return route.fulfill(json({ items: fixture.items }));

  let m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
  if (m) return route.fulfill(json(fixture.details[`${m[1]}/${m[2]}/${m[3]}`] ?? {}));

  m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews$/);
  if (m) return route.fulfill(json(fixture.reviews[`${m[1]}/${m[2]}/${m[3]}`] ?? []));

  m = path.match(/^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]+)\/status$/);
  if (m) return route.fulfill(json(fixture.statuses[m[1]] ?? { state: "success", total_count: 0 }));

  m = path.match(/^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]+)\/check-runs$/);
  if (m) return route.fulfill(json(fixture.checkruns[m[1]] ?? { total_count: 0, check_runs: [] }));

  if (path === "/graphql") {
    return route.fulfill(
      json({ data: { markPullRequestReadyForReview: { pullRequest: { number: 1, isDraft: false } } } }),
    );
  }
  return route.fulfill(json({}));
});

await page.route("https://api.linear.app/**", (route) => {
  const body = route.request().postDataJSON();
  if (body?.query?.includes("viewer")) return route.fulfill(json({ data: { viewer: { name: "Amit" } } }));
  return route.fulfill(
    json({ data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: fixture.issues } } }),
  );
});

await page.addInitScript(() => {
  localStorage.setItem(
    "prtower.config",
    JSON.stringify({ githubToken: "ghp_test", linearKey: "lin_api_test", org: "acme" }),
  );
});

const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

await page.goto(`file://${resolve(root, "dist/index.html")}`);
await page.waitForSelector(".lane-tab", { timeout: 15000 });
await page.waitForFunction(() => !document.querySelector(".icon-btn")?.textContent?.includes("Loading"), {
  timeout: 30000,
});
await page.waitForTimeout(400);

const shot = async (name) => {
  await page.screenshot({ path: `${out}/${theme}-${name}.png`, fullPage: true });
};

await shot("send");

for (const [tab, name] of [
  ["Held back", "held"],
  ["Out for review", "flight"],
  ["Everything", "tree"],
]) {
  await page.getByRole("tab", { name: new RegExp(tab) }).click();
  await page.waitForTimeout(250);
  await shot(name);
}

// Selection + the confirm dialog, on the send lane.
await page.getByRole("tab", { name: /Ready to send/ }).click();
await page.waitForTimeout(200);
const boxes = page.locator(".check");
const count = await boxes.count();
for (let i = 0; i < Math.min(2, count); i++) await boxes.nth(i).click();
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/${theme}-selected.png`, fullPage: true });
await page.getByRole("button", { name: /Send \d+ for review/ }).click();
await page.waitForSelector(".dialog", { timeout: 5000 });
await page.waitForTimeout(250);
await page.screenshot({ path: `${out}/${theme}-confirm.png` });

const before = await page.evaluate(() =>
  [...document.querySelectorAll(".lane-tab")].map((tab) => tab.textContent.trim()),
);

// Complete the send and confirm the PRs actually leave the queue.
await page.getByRole("button", { name: /^Send \d+$/ }).click();
await page.waitForSelector(".result-ok, .result-bad", { timeout: 10000 });
await page.screenshot({ path: `${out}/${theme}-sent.png` });
const outcome = await page.evaluate(() => ({
  heading: document.querySelector(".dialog h2")?.textContent,
  ok: document.querySelectorAll(".result-ok").length,
  bad: document.querySelectorAll(".result-bad").length,
}));
await page.getByRole("button", { name: "Done" }).click();
await page.waitForTimeout(300);
const after = await page.evaluate(() =>
  [...document.querySelectorAll(".lane-tab")].map((tab) => tab.textContent.trim()),
);

console.log("lanes before:", before.join("  |  "));
console.log("send result :", outcome.heading, `(ok=${outcome.ok} failed=${outcome.bad})`);
console.log("lanes after :", after.join("  |  "));
console.log(errors.length ? `PAGE ERRORS:\n${errors.join("\n")}` : "no page errors");

await browser.close();
