import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, rmSync, existsSync } from "fs";
import { resolve } from "path";

// Folds the emitted JS and CSS back into index.html so the build is one file
// that runs from file:// with no server. The script must be a classic script,
// not a module: a browser refuses to load module scripts over file://, which is
// why the build below forces the iife format.
function inlineEverything(): Plugin {
  return {
    name: "inline-everything",
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find(
        (file) => file.type === "asset" && file.fileName.endsWith(".html"),
      );
      if (!html || html.type !== "asset") return;

      let source = String(html.source);

      // The replacement must be a function. A string replacement expands $&,
      // $1 and friends, and minified JS is full of them — one $& re-inserts the
      // whole matched <script> tag inside the inline script, whose </script>
      // then closes it early and dumps the rest of the bundle into the page.
      const swap = (pattern: RegExp, replacement: string, what: string) => {
        if (!pattern.test(source)) {
          this.error(`inline-everything: no ${what} tag matched ${pattern}`);
        }
        source = source.replace(pattern, () => replacement);
      };

      const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      for (const [name, file] of Object.entries(bundle)) {
        if (file.type === "chunk" && file.fileName.endsWith(".js")) {
          // Vite hoists the entry script into <head>. A module script defers,
          // but an inline classic script does not — left there it would run
          // before #app exists. Drop the tag and append the code at the end of
          // <body> instead.
          swap(
            new RegExp(`<script[^>]*src=["'][^"']*${escape(file.fileName)}["'][^>]*></script>`),
            "",
            "script",
          );
          if (!source.includes("</body>")) this.error("inline-everything: no </body> to append the script to");
          source = source.replace("</body>", () => `<script>\n${file.code}\n</script>\n</body>`);
          delete bundle[name];
        }
        if (file.type === "asset" && file.fileName.endsWith(".css")) {
          swap(
            new RegExp(`<link[^>]*href=["'][^"']*${escape(file.fileName)}["'][^>]*>`),
            `<style>\n${String(file.source)}\n</style>`,
            "stylesheet",
          );
          delete bundle[name];
        }
      }

      // crossorigin on an inline tag is meaningless and trips file:// in Safari.
      source = source.replace(/\s+crossorigin(=["'][^"']*["'])?/g, "");
      html.source = source;
    },
    closeBundle() {
      // Vite still writes the empty assets directory; nothing should ship but
      // the one file.
      const assets = resolve(__dirname, "dist/assets");
      if (existsSync(assets)) rmSync(assets, { recursive: true, force: true });
      const out = resolve(__dirname, "dist/index.html");
      if (existsSync(out)) {
        const size = readFileSync(out).length;
        console.log(`\n  single file: dist/index.html  ${(size / 1024).toFixed(0)} kB\n`);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), inlineEverything()],
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  build: {
    target: "es2022",
    cssCodeSplit: false,
    assetsInlineLimit: 1024 * 1024,
    rollupOptions: {
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "assets/app.js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
