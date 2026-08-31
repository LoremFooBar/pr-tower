// End-to-end check of the real thing: starts a stand-in for GitHub and Linear,
// starts the actual server against it, then drives the actual page in a browser
// through every lane and a completed send. Screenshots land in shots/.
//
//   npm run verify              headless, demo fixture
//   FIXTURE=path npm run verify use another capture
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = resolve(root, "shots");
const state = resolve(root, ".verify-state");
mkdirSync(out, { recursive: true });
rmSync(state, { recursive: true, force: true });
mkdirSync(state, { recursive: true });

const UPSTREAM = 5179;
const APP = 5180;
const children = [];

function start(command, args, env, name) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  children.push(child);
  return child;
}

async function waitFor(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`${url} never came up`);
}

function stop() {
  for (const child of children) child.kill();
}

process.on("exit", stop);
process.on("SIGINT", () => {
  stop();
  process.exit(1);
});

start("node", [resolve(here, "mock-upstream.mjs")], {}, "upstream");
start(
  "node",
  [resolve(root, "dist/server.js")],
  {
    // Cleared so an ambient token on the developer's machine cannot pin the
    // config and change what this test exercises.
    GITHUB_TOKEN: "",
    LINEAR_KEY: "",
    GITHUB_ORG: "",
    GITHUB_API: `http://localhost:${UPSTREAM}`,
    LINEAR_API: `http://localhost:${UPSTREAM}/linear`,
    PRTOWER_CONFIG: resolve(state, "config.json"),
    PRTOWER_SNAPSHOT: resolve(state, "snapshot.json"),
    PORT: String(APP),
  },
  "server",
);

await waitFor(`http://localhost:${UPSTREAM}/user`);
await waitFor(`http://localhost:${APP}/api/status`);

const browser = await chromium.launch();
const problems = [];

for (const theme of ["dark", "light"]) {
  const page = await browser.newPage({
    viewport: { width: 1180, height: 1000 },
    colorScheme: theme,
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => problems.push(`[${theme}] ${error}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`[${theme}] ${message.text()}`);
  });

  await page.goto(`http://localhost:${APP}/`);

  // First visit: the setup screen, because the server holds no token yet.
  if (theme === "dark") {
    await page.waitForSelector("#gh", { timeout: 10000 });
    await page.screenshot({ path: `${out}/${theme}-setup.png`, fullPage: true });
    await page.fill("#gh", "ghp_typed_by_the_test");
    await page.fill("#ln", "lin_api_typed_by_the_test");
    await page.fill("#org", "acme");
    await page.getByRole("button", { name: "Connect" }).click();
  }

  // Selectors go through roles and text: shadcn emits utility classes, which are
  // not a contract anything should be pinned to.
  const cards = () => page.getByRole("button", { name: /Release for review/ });

  // The queue starts collapsed and Radix drops the content, so everything below
  // needs it opened first.
  const queue = page.getByRole("button", { name: /Ready to release/ });
  await queue.waitFor({ timeout: 20000 });
  await page.screenshot({ path: `${out}/${theme}-collapsed.png`, fullPage: true });
  if ((await cards().count()) > 0) problems.push("the queue rendered its cards while collapsed");
  await queue.click();
  await cards().first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${theme}-board.png`, fullPage: true });

  if (theme === "dark") {
    const ready = await cards().count();

    // One click, because PRs of a ticket that must land together select as a
    // pair — clicking a second box would toggle the pair straight back off.
    await page.getByRole("checkbox").first().click();
    const dock = page.getByText(/\d+ selected/);
    await dock.waitFor({ timeout: 5000 });
    const selected = Number(/(\d+) selected/.exec((await dock.textContent()) ?? "")?.[1] ?? 0);
    console.log(`ready to release: ${ready} · one click selected: ${selected}`);
    if (selected < 1) problems.push("selecting a card did not open the release bar");
    await page.screenshot({ path: `${out}/${theme}-selected.png`, fullPage: true });

    await page.getByRole("button", { name: new RegExp(`^Release ${selected}$`) }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 5000 });
    await page.screenshot({ path: `${out}/${theme}-confirm.png` });

    // Radix owns this now; check it still holds.
    const focusInside = await page
      .evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))
      .catch(() => null);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const closed = (await page.getByRole("dialog").count()) === 0;
    console.log(`modal focus trapped: ${focusInside ? "yes" : "NO"} · escape closes: ${closed ? "yes" : "NO"}`);
    if (!closed) problems.push("Escape did not close the release dialog");
    if (!focusInside) problems.push("the dialog did not take focus");

    const stillSelected = await page.getByText(/\d+ selected/).count();
    if (!stillSelected) problems.push("Escape cleared the selection as well as closing the dialog");

    await page.getByRole("button", { name: new RegExp(`^Release ${selected}$`) }).click();
    await page.getByRole("dialog").waitFor({ timeout: 5000 });
    await page.getByRole("dialog").getByRole("button", { name: /^Release \d+$/ }).click();

    const toastText = page.getByText(/Released \d+ PRs? for review/);
    await toastText.waitFor({ timeout: 15000 });
    await page.screenshot({ path: `${out}/${theme}-released.png` });
    console.log(`toast: ${await toastText.textContent()}`);

    const undo = page.getByRole("button", { name: "Undo" });
    const hasUndo = await undo.count();
    console.log(`undo offered  : ${hasUndo ? "yes" : "NO"}`);
    if (!hasUndo) problems.push("no undo was offered after a release");
    else {
      await undo.click();
      await page.waitForTimeout(900);
      console.log(`ready after undo: ${await cards().count()} (was ${ready})`);
    }

    // Two stacks of two in the fixture, read two different ways: #418 declares
    // #412 as its base, while worker #81 only carries #77's head commit. Four
    // badges, because both ends of a stack are badged.
    const stackBadges = await page.getByText(/\b[12] of 2\b/).count();
    console.log(`stack badges shown      : ${stackBadges} (want 4)`);
    if (stackBadges < 4) problems.push(`only ${stackBadges} stack badges; a stack went unread`);

    // Two PRs of ACME-980 are tied together, so exactly one group is bracketed.
    const tied = await page.locator("[data-tied]").count();
    console.log(`tied groups bracketed   : ${tied} (want 1+)`);
    if (tied < 1) problems.push("a ticket with two PRs drew no tie");

    const server = await (await fetch(`http://localhost:${APP}/api/data`)).json();
    console.log(`server drafts remaining: ${server.prs.filter((pr) => pr.draft).length}`);

    const status = await (await fetch(`http://localhost:${APP}/api/status`)).text();
    if (/ghp_|lin_api_/.test(status)) problems.push("status leaked a token to the client");
    const html = await (await fetch(`http://localhost:${APP}/`)).text();
    if (/ghp_typed|lin_api_typed/.test(html)) problems.push("the page contains a token");
    console.log("token never sent to the browser: ok");
  }

  await page.close();
}

// The auto-sync signal: a subscriber must hear about a refresh it did not ask
// for. Driven by a forced refresh, because the five-minute timer outlives the
// test run.
{
  const stream = await fetch(`http://localhost:${APP}/api/events`);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const untilSync = (async () => {
    while (!/^event: sync$/m.test(seen)) {
      const { value, done } = await reader.read();
      if (done) return seen;
      seen += decoder.decode(value, { stream: true });
    }
    return seen;
  })();

  await fetch(`http://localhost:${APP}/api/data?force=1`);
  const frame = await Promise.race([untilSync, new Promise((r) => setTimeout(() => r(seen), 15000))]);

  if (!/^event: sync$/m.test(frame)) problems.push("a refresh reached no /api/events subscriber");
  else console.log(`sync signal delivered: ${frame.trim().split("\n").join(" ")}`);
  if (/ghp_|lin_api_/.test(frame)) problems.push("the event stream leaked a token");
  await reader.cancel();
}

await browser.close();
stop();
rmSync(state, { recursive: true, force: true });

console.log(problems.length ? `\nPROBLEMS:\n${problems.join("\n")}` : "\nno page errors");
process.exit(problems.length ? 1 : 0);
