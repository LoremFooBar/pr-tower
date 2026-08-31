// Renders the app icons from the favicon already inlined in index.html, so the
// mark has one source of truth. Committed output, like the fonts: the Docker
// build runs npm ci without Playwright's browsers, so this cannot be a step of
// npm run build.
//
//   npm run icons
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const icon = /<link rel="icon" href="([^"]+)"/.exec(html)?.[1];
if (!icon) throw new Error("make-icons: no favicon found in index.html");

// The amber field the mark already sits on, so a padded icon has no seam.
const FIELD = "#f59e0b";

const browser = await chromium.launch();

async function shoot(size, scale, name) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<body style="margin:0;width:${size}px;height:${size}px;background:${FIELD};
       display:flex;align-items:center;justify-content:center">
       <img src="${icon}" style="width:${Math.round(size * scale)}px;height:${Math.round(size * scale)}px">
     </body>`,
  );
  await page.screenshot({ path: resolve(root, "public", name), omitBackground: false });
  await page.close();
  console.log(`  ${name}  ${size}x${size}`);
}

// A maskable icon is cropped to a circle by the platform, so the mark is pulled
// well inside the safe zone rather than filling the square.
await shoot(192, 1, "icon-192.png");
await shoot(512, 1, "icon-512.png");
await shoot(512, 0.6, "icon-maskable-512.png");

await browser.close();
