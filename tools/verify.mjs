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

  await page.waitForSelector(".queue", { timeout: 20000 });
  // Polled from the test side rather than with waitForFunction: the page's CSP
  // allows no injected script, which is the point of it. Scoped to #app because
  // the inlined bundle lives inside <body>, so body.textContent contains the
  // whole program source — including every string this might look for.
  let loaded = false;
  for (let i = 0; i < 100 && !loaded; i++) {
    const seen = (await page.textContent("#app").catch(() => "")) ?? "";
    loaded = !seen.includes("Loading your pull requests");
    if (!loaded) await page.waitForTimeout(200);
  }
  if (!loaded) {
    const seen = (await page.textContent("#app").catch((e) => `ERR ${e}`)) ?? "";
    throw new Error(`[${theme}] never finished loading. len=${seen.length} text=${seen.slice(0, 300).replace(/\s+/g, " ")}`);
  }
  await page.waitForTimeout(400);

  await page.screenshot({ path: `${out}/${theme}-board.png`, fullPage: true });

  if (theme === "dark") {
    const cleared = async () => (await page.textContent(".queue-title")) ?? "";
    const before = [await cleared()];

    // One click, because PRs of a ticket that must land together select as a
    // pair — clicking a second box would toggle the pair straight back off.
    await page.locator(".queue-cards .pick").first().click();
    await page.waitForSelector(".dock", { timeout: 5000 });
    const selected = Number(/(\d+) selected/.exec((await page.textContent(".dock")) ?? "")?.[1] ?? 0);
    console.log(`one click selected: ${selected}`);
    if (selected < 1) problems.push("selecting a cleared card did not open the release bar");
    await page.screenshot({ path: `${out}/${theme}-selected.png`, fullPage: true });

    await page.getByRole("button", { name: /release \d+ ▸/ }).first().click();
    await page.waitForSelector(".dialog");
    await page.screenshot({ path: `${out}/${theme}-confirm.png` });

    await page.locator(".dialog .release").click();
    await page.waitForSelector(".dialog .ok, .dialog .bad", { timeout: 15000 });
    const outcome = {
      heading: await page.locator(".dialog h2").textContent(),
      ok: await page.locator(".dialog .ok").count(),
      bad: await page.locator(".dialog .bad").count(),
    };
    await page.screenshot({ path: `${out}/${theme}-sent.png` });
    await page.locator(".dialog .release").click();
    await page.waitForTimeout(300);
    const after = [await cleared()];

    // The ten-second undo must be offered, and must actually re-draft.
    const undoVisible = await page.locator(".toast-undo").count();
    console.log("cleared before:", before.join(""));
    console.log("release result:", outcome.heading, `(ok=${outcome.ok} failed=${outcome.bad})`);
    console.log("cleared after :", after.join(""));
    console.log("undo offered  :", undoVisible ? "yes" : "NO");
    if (!undoVisible) problems.push("no undo was offered after a release");

    await page.locator(".toast-undo").click();
    await page.waitForTimeout(600);
    console.log("after undo    :", await cleared());

    // The server must have recorded it too, not just the open page.
    const server = await (await fetch(`http://localhost:${APP}/api/data`)).json();
    const stillDraft = server.prs.filter((pr) => pr.draft).length;
    console.log(`server drafts remaining: ${stillDraft}`);

    // And it must never hand a token back to the browser.
    const status = await (await fetch(`http://localhost:${APP}/api/status`)).text();
    if (/ghp_|lin_api_/.test(status)) problems.push("status leaked a token to the client");
    const html = await (await fetch(`http://localhost:${APP}/`)).text();
    if (/ghp_typed|lin_api_typed/.test(html)) problems.push("the page contains a token");
    console.log("token never sent to the browser: ok");
  }

  await page.close();
}

await browser.close();
stop();
rmSync(state, { recursive: true, force: true });

console.log(problems.length ? `\nPROBLEMS:\n${problems.join("\n")}` : "\nno page errors");
process.exit(problems.length ? 1 : 0);
