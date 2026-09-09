import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The module reads its path and the environment once per load, so each case
// gets a fresh copy.
async function withEnv(env: Record<string, string | undefined>, file: string) {
  jest.resetModules();
  const saved = { ...process.env };
  Object.assign(process.env, env, { PRTOWER_CONFIG: file });
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
  }
  const mod = await import("../server/config");
  return {
    mod,
    restore: () => {
      process.env = saved;
    },
  };
}

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "prtower-")), "config.json");
}

describe("token storage", () => {
  it("writes a typed token to the file", async () => {
    const file = tmpFile();
    const { mod, restore } = await withEnv({ GITHUB_TOKEN: undefined, LINEAR_KEY: undefined }, file);
    mod.saveTokens({ githubToken: "ghp_typed", linearKey: "lin_typed", org: "acme", mergedDays: 7 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      githubToken: "ghp_typed",
      linearKey: "lin_typed",
      org: "acme",
      mergedDays: 7,
    });
    restore();
  });

  it("never writes a token that came from the environment", async () => {
    const file = tmpFile();
    const { mod, restore } = await withEnv({ GITHUB_TOKEN: "ghp_from_env" }, file);
    mod.saveTokens({ githubToken: "ghp_from_env", linearKey: "lin_typed", org: "acme", mergedDays: 7 });
    const written = JSON.parse(readFileSync(file, "utf8"));
    // The secret stays in the variable that supplied it.
    expect(written.githubToken).toBe("");
    expect(written.linearKey).toBe("lin_typed");
    // It is still used at runtime, just not persisted.
    expect(mod.loadTokens().githubToken).toBe("ghp_from_env");
    restore();
  });

  it("keeps an existing file token when the environment later pins one", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ githubToken: "ghp_old", linearKey: "", org: "acme" }));
    const { mod, restore } = await withEnv({ GITHUB_TOKEN: "ghp_from_env" }, file);
    mod.saveTokens({ githubToken: "ghp_from_env", linearKey: "", org: "other", mergedDays: 7 });
    // The file's own value is left alone rather than being overwritten with the
    // environment's copy.
    expect(JSON.parse(readFileSync(file, "utf8")).githubToken).toBe("ghp_old");
    restore();
  });

  it("reports which tokens the environment pins", async () => {
    const file = tmpFile();
    const { mod, restore } = await withEnv({ GITHUB_TOKEN: "x", LINEAR_KEY: undefined }, file);
    expect(mod.envPinned()).toEqual({ githubToken: true, linearKey: false });
    restore();
  });
});
