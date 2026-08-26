// Bundles the backend to one CommonJS-free ESM file so the image needs no
// node_modules at runtime.
import { build } from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [resolve(root, "server/index.ts")],
  outfile: resolve(root, "dist/server.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: false,
  logLevel: "info",
});
