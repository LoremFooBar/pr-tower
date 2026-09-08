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

    // web #888 carries a comment from dana and one from a bot. Only a person
    // counts as somebody reading the change.
    const board = (await page.textContent("#app")) ?? "";
    console.log(`reviewer named          : ${board.includes("dana") ? "yes" : "NO"}`);
    if (!board.includes("dana")) problems.push("a PR with a human review named nobody");
    if (/coderabbit/i.test(board)) problems.push("a bot was reported as a reviewer");

    // The avatar must arrive inlined. An external src would be blocked by the
    // page's own CSP and show nothing, so this is the assertion that matters.
    // mira reviewed web #902, which is a draft: a reader is worth naming
    // whether or not the PR has been sent out yet.
    console.log(`reviewer on a draft     : ${board.includes("mira") ? "yes" : "NO"}`);
    if (!board.includes("mira")) problems.push("a draft with a human review named nobody");

    const faces = await page.locator("#app img[src^='data:image/']").count();
    const external = await page.locator("#app img:not([src^='data:'])").count();
    console.log(`avatars inlined         : ${faces} (external: ${external})`);
    if (faces < 1) problems.push("a reviewer's avatar never reached the page");
    if (external > 0) problems.push("an image on the page points somewhere external");

    // Two PRs of ACME-980 are tied together, so exactly one group is bracketed.
    const tied = await page.locator("[data-tied]").count();
    console.log(`tied groups bracketed   : ${tied} (want 1+)`);
    if (tied < 1) problems.push("a ticket with two PRs drew no tie");

    // The filter narrows the board and leaves the counts honest about the rest.
    // Rows carry data-pr; a checkbox would only count the releasable ones.
    const rows = () => page.locator("#app [data-pr]").count();
    const filter = page.getByLabel("Filter pull requests");
    const before = await rows();

    await filter.fill("rollup");
    await page.waitForTimeout(250);
    const after = await rows();
    const header = (await page.textContent("header")) ?? "";
    const tally = /\d+ of \d+/.exec(header)?.[0] ?? "?";
    console.log(`filter "rollup"         : ${after} of ${before} rows · header "${tally}"`);
    if (after === 0) problems.push("the filter hid everything, including the match");
    if (after >= before) problems.push("the filter narrowed nothing");
    if (tally === "?") problems.push("the header did not say how much is hidden");

    const matched = (await page.textContent("#app")) ?? "";
    if (!/rollup/i.test(matched)) problems.push("the rows left do not contain the term");

    await filter.fill("zzzzz-no-such-pr");
    await page.waitForTimeout(250);
    if (!((await page.textContent("#app")) ?? "").includes("Nothing matches")) {
      problems.push("a filter matching nothing said nothing");
    }

    // Escape empties it, and the board comes back whole.
    await filter.press("Escape");
    await page.waitForTimeout(250);
    const restored = await rows();
    console.log(`filter cleared          : ${restored} rows (was ${before})`);
    if (restored !== before) problems.push(`clearing left ${restored} rows, not ${before}`);

    // Stage chips. They are toggles, not tabs: each one says how many PRs are at
    // that stage, picking one narrows the board to exactly that many, and a
    // second one widens rather than narrows.
    const chip = (stage) => page.locator(`#app [data-stage="${stage}"]`);
    const stageCount = async (stage) =>
      Number(/(\d+)$/.exec((await chip(stage).textContent()) ?? "")?.[1] ?? -1);

    const STAGES = ["merge", "ready", "needs", "review", "blocked"];
    const shows = {};
    for (const stage of STAGES) shows[stage] = await stageCount(stage);
    const summed = STAGES.reduce((total, stage) => total + shows[stage], 0);
    console.log(
      `stage chips             : ${STAGES.map((s) => `${s} ${shows[s]}`).join(" · ")} = ${summed}`,
    );
    if (summed !== before) {
      problems.push(`the stage chips add up to ${summed}, but the board has ${before} rows`);
    }

    const one = STAGES.find((stage) => shows[stage] > 0 && shows[stage] < before);
    if (!one) problems.push("no stage held some but not all of the board; the chips prove nothing");
    else {
      await chip(one).click();
      await page.waitForTimeout(250);
      const narrowed = await rows();
      console.log(`chip "${one}"`.padEnd(24) + `: ${narrowed} rows (chip says ${shows[one]})`);
      if (narrowed !== shows[one]) {
        problems.push(`the ${one} chip says ${shows[one]} but the board shows ${narrowed} rows`);
      }
      if ((await stageCount(one)) !== shows[one]) {
        problems.push("picking a chip changed its own count");
      }
      const other = STAGES.find((stage) => stage !== one && shows[stage] > 0);
      if (other) {
        if ((await stageCount(other)) !== shows[other]) {
          problems.push(`picking ${one} zeroed the ${other} chip`);
        }
        await chip(other).click();
        await page.waitForTimeout(250);
        const widened = await rows();
        console.log(`chip + "${other}"`.padEnd(24) + `: ${widened} rows`);
        if (widened !== shows[one] + shows[other]) {
          problems.push(`two chips showed ${widened} rows, not ${shows[one] + shows[other]}`);
        }
      }
      await page.screenshot({ path: `${out}/${theme}-stages.png`, fullPage: true });

      await page.locator("#app [data-stage-clear]").click();
      await page.waitForTimeout(250);
      const back = await rows();
      console.log(`chips cleared           : ${back} rows (was ${before})`);
      if (back !== before) problems.push(`clearing the chips left ${back} rows, not ${before}`);
    }

    // Cmd/Ctrl+F opens the filter and closes it again, in place of the
    // browser's own find-in-page.
    const focusLabel = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    await page.keyboard.press("ControlOrMeta+f");
    await page.waitForTimeout(200);
    const opened = (await focusLabel()) === "Filter pull requests";
    await page.keyboard.type("rollup");
    await page.waitForTimeout(250);
    const typed = await rows();
    await page.keyboard.press("ControlOrMeta+f");
    await page.waitForTimeout(250);
    const shut = (await focusLabel()) !== "Filter pull requests";
    const emptied = await rows();
    console.log(
      `cmd+F opens/closes      : ${opened ? "yes" : "NO"}/${shut ? "yes" : "NO"} · ` +
        `${typed} rows while filtering, ${emptied} after`,
    );
    if (!opened) problems.push("Cmd+F did not put the cursor in the filter");
    if (!shut) problems.push("Cmd+F a second time did not close the filter");
    if (typed >= before) problems.push("typing after Cmd+F narrowed nothing");
    if (emptied !== before) problems.push(`closing the filter left ${emptied} rows, not ${before}`);

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

// Installability: the manifest and its icons are the only files the page does
// not carry itself, so they are the only ones that can go missing from the
// image. Chrome logs a manifest it dislikes as a console error, which the page
// listeners above already collect.
{
  const res = await fetch(`http://localhost:${APP}/manifest.webmanifest`);
  const type = res.headers.get("content-type") ?? "";
  const manifest = await res.json().catch(() => null);
  console.log(`manifest served         : ${res.status} ${type}`);
  if (!type.includes("application/manifest+json")) problems.push(`manifest content-type was ${type}`);

  const sizes = (manifest?.icons ?? []).map((icon) => icon.sizes);
  for (const required of ["192x192", "512x512"]) {
    if (!sizes.includes(required)) problems.push(`manifest declares no ${required} icon`);
  }
  if (manifest?.start_url !== "/") problems.push("manifest start_url is not /");
  if (!manifest?.display) problems.push("manifest declares no display mode");

  for (const icon of manifest?.icons ?? []) {
    const image = await fetch(`http://localhost:${APP}${icon.src}`);
    const imageType = image.headers.get("content-type") ?? "";
    if (!image.ok || !imageType.includes("image/png")) {
      problems.push(`${icon.src} came back ${image.status} ${imageType}`);
    }
  }
  console.log(`icons served            : ${(manifest?.icons ?? []).length}`);

  // Chrome's own verdict on the manifest, which is the one that decides whether
  // an install is offered at all.
  const check = await browser.newPage();
  await check.goto(`http://localhost:${APP}/`);
  const cdp = await check.context().newCDPSession(check);
  const parsed = await cdp.send("Page.getAppManifest");
  console.log(`chrome manifest errors  : ${parsed.errors.length}`);
  for (const error of parsed.errors) problems.push(`manifest: ${error.message ?? JSON.stringify(error)}`);
  await check.close();

  // The install files are same-origin; the policy must still reach nowhere else.
  const csp = (await fetch(`http://localhost:${APP}/`)).headers.get("content-security-policy") ?? "";
  if (!csp.includes("default-src 'none'")) problems.push("the page lost default-src 'none'");
  if (!csp.includes("manifest-src 'self'")) problems.push("the CSP does not allow its own manifest");
  if (/https?:\/\//.test(csp)) problems.push(`the CSP names an external host: ${csp}`);
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

// Desktop notifications. The page raises one per author per PR for the comments
// the server reports as new, and says nothing about the bots nobody asked for or
// about the reader's own remarks. The Notification constructor is replaced so
// the test can read what would have been shown.
{
  const page = await browser.newPage({
    viewport: { width: 1180, height: 900 },
    permissions: ["notifications"],
  });
  page.on("pageerror", (error) => problems.push(`[notify] ${error}`));

  await page.addInitScript(() => {
    window.__notes = [];
    class Stub {
      constructor(title, options) {
        window.__notes.push({ title, body: options?.body ?? "", tag: options?.tag ?? "" });
      }
      close() {}
    }
    Stub.permission = "granted";
    Stub.requestPermission = () => Promise.resolve("granted");
    Object.defineProperty(window, "Notification", {
      value: Stub,
      writable: true,
      configurable: true,
    });
  });

  await page.goto(`http://localhost:${APP}/`);
  await page.getByRole("button", { name: /Ready to release/ }).waitFor({ timeout: 20000 });

  // Whatever the page loaded with is its baseline. This sweep is the one it
  // should speak about.
  await fetch(`http://localhost:${APP}/api/data?force=1`);
  await page.waitForTimeout(2500);

  const notes = await page.evaluate(() => window.__notes ?? []);
  const titles = notes.map((note) => note.title);
  console.log(`comment notifications   : ${titles.length}`);
  for (const title of titles) console.log(`  ${title}`);

  // dana wrote one conversation comment and one review message on web #888.
  // That is one thing that happened, so it is one notification saying two.
  if (!titles.some((title) => /^dana commented on web #888 \(2\)$/.test(title))) {
    problems.push("a person's comment and their review message did not arrive as one notification");
  }
  if (!titles.some((title) => /^Bugbot commented on web #\d+$/.test(title))) {
    problems.push("Bugbot commented and the desktop was never told");
  }
  if (titles.some((title) => /coderabbit/i.test(title))) {
    problems.push("a bot other than Bugbot raised a notification");
  }
  if (titles.some((title) => /^you commented/.test(title))) {
    problems.push("the reader's own comment raised a notification");
  }
  if (notes.some((note) => !note.body)) problems.push("a notification carried no body");
  if (new Set(notes.map((note) => note.tag)).size !== notes.length) {
    problems.push("two notifications shared a tag and would replace each other");
  }

  // The control is one glyph in the header, and the mute is the same click back.
  const mute = page.getByRole("button", { name: "Mute comment notifications" });
  if ((await mute.count()) !== 1) problems.push("the notification control is missing");
  else {
    await mute.click();
    const unmute = page.getByRole("button", { name: "Notify me about new comments" });
    const flipped = (await unmute.count()) === 1;
    console.log(`mute flips the control   : ${flipped ? "yes" : "NO"}`);
    if (!flipped) problems.push("muting did not change the notification control");
  }

  await page.close();
}

// Opening a PR with no extension installed. The test browser has none, so this
// is the plain case: a real anchor, a real new tab, nothing intercepting. The
// second half marks the page the way the extension does, to prove the marker is
// what gates the interception rather than the click going through by luck.
{
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  page.on("pageerror", (error) => problems.push(`[prhub] ${error}`));
  const context = page.context();
  // github.com is answered locally: this harness must not need the internet.
  await context.route("https://github.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>stub</title>" }),
  );

  await page.goto(`http://localhost:${APP}/`);
  await page.locator("#app [data-pr]").first().waitFor({ timeout: 20000 });

  const marked = await page.evaluate(() => document.documentElement.dataset.prHub ?? null);
  console.log(`pr-hub marker present   : ${marked ?? "no"}`);
  if (marked) problems.push("the test browser claims the PR Hub extension is installed");

  const link = page.locator("#app a[href^='https://github.com/'][href*='/pull/']").first();
  const href = await link.getAttribute("href");
  const attrs = await link.evaluate((node) => ({ target: node.target, rel: node.rel }));
  console.log(`pr link                 : ${attrs.target} ${attrs.rel} ${href}`);
  if (attrs.target !== "_blank") problems.push("a PR link does not open in a new tab");
  if (!attrs.rel.includes("noreferrer")) problems.push("a PR link leaks a referrer");

  const opened = await Promise.all([
    context.waitForEvent("page", { timeout: 10000 }).catch(() => null),
    link.click(),
  ]).then(([tab]) => tab);
  console.log(`plain click opens       : ${opened ? opened.url() : "NOTHING"}`);
  if (!opened) problems.push("a plain click opened no tab with no extension installed");
  else {
    if (opened.url() !== href) problems.push(`the click landed on ${opened.url()}, not the PR`);
    await opened.close();
  }

  // Now the positive control: mark the page as the extension does.
  await page.evaluate(() => {
    document.documentElement.dataset.prHub = "1";
    window.__prhub = null;
    window.addEventListener("message", (event) => {
      if (event.data?.type === "prhub:open-pr") window.__prhub = event.data;
    });
  });
  const tabsBefore = context.pages().length;
  await link.click();
  await page.waitForTimeout(600);
  const handed = await page.evaluate(() => window.__prhub);
  const tabsAfter = context.pages().length;
  console.log(`marked click hands over : ${handed ? handed.url : "NO"} · tabs ${tabsBefore}→${tabsAfter}`);
  if (!handed) problems.push("with the marker set, the click was not handed to the extension");
  if (tabsAfter !== tabsBefore) problems.push("with the marker set, the click still opened a tab");

  await page.close();
}

await browser.close();
stop();
rmSync(state, { recursive: true, force: true });

console.log(problems.length ? `\nPROBLEMS:\n${problems.join("\n")}` : "\nno page errors");
process.exit(problems.length ? 1 : 0);
