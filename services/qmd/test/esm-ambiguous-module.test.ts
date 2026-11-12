import { beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// One build for the whole file: both tests exercise the compiled CLI.
beforeAll(() => {
  execFileSync(process.execPath, ["scripts/build.mjs"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
}, 120_000);

describe("Node ESM entrypoints", () => {
  test("CLI --index path normalizes via setIndexName/setConfigIndexName under Node 22+", () => {
    const indexPath = join(mkdtempSync(join(tmpdir(), "qmd-index-")), "nested", "idx");
    const output = execFileSync(process.execPath, ["dist/cli/qmd.js", "--index", indexPath, "--version"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });

    expect(output).toContain("qmd ");
  }, 120_000);

  // Regression for #787: the commit must come from the build, not from
  // whatever repository the install happens to sit inside.
  test("the build stamps only a standalone qmd checkout", () => {
    const stampPath = join(repoRoot, "dist", "cli", "build-info.json");
    expect(existsSync(stampPath), "scripts/build.mjs should write dist/cli/build-info.json").toBe(true);
    const stamp = JSON.parse(readFileSync(stampPath, "utf-8")) as { commit?: string };

    const output = execFileSync(process.execPath, ["dist/cli/qmd.js", "--version"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();

    // `qmd 2.6.3` or `qmd 2.6.3 (abc1234)` / `(abc1234-dirty)` — never anything else.
    expect(output).toMatch(/^qmd \d+\.\d+\.\d+(?: \([0-9a-f]{7,}(?:-dirty)?\))?$/);

    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (realpathSync(top) !== realpathSync(repoRoot)) {
      // The embedded fork should preserve upstream's enclosing-repo guard.
      expect(stamp.commit).toBe("");
      expect(output).not.toContain("(");
      return;
    }

    // In a standalone checkout, the stamp must be qmd's HEAD.
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    expect(stamp.commit).toMatch(new RegExp(`^${head}(?:-dirty)?$`));
    expect(output).toContain(`(${stamp.commit})`);
  }, 120_000);
});
