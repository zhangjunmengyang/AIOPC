import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const qmd = fileURLToPath(new URL("../../../services/qmd/", import.meta.url));
const defaultOutput = fileURLToPath(new URL("../dist/aiopc-qmd/", import.meta.url));
const output = process.argv[2] ? resolve(process.argv[2]) : defaultOutput;
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const bunPath = process.env.AIOPC_QMD_BUN?.trim() || "bun";
const localBun = spawnSync(bunPath, ["--version"], { stdio: "ignore" }).status === 0;
const bun = localBun ? bunPath : pnpm;
const prefix = localBun ? [] : ["dlx", "bun@1.4.4"];

function run(args) {
  const result = spawnSync(bun, [...prefix, ...args], {
    cwd: qmd, stdio: "inherit", shell: process.platform === "win32" && bun === pnpm,
  });
  if (result.status !== 0) throw result.error ?? new Error(`qmd build command exited with ${result.status}`);
}

run(["install", "--frozen-lockfile", "--ignore-scripts"]);
mkdirSync(output, { recursive: true });
run(["build", "src/aiopc.ts", "--target=node", "--format=esm",
  "--external", "node-llama-cpp", "--external", "better-sqlite3", "--external", "sqlite-vec",
  "--outfile", join(output, "aiopc-qmd.mjs")]);
const files = { darwin: "vec0.dylib", linux: "vec0.so", win32: "vec0.dll" };
const platform = process.platform;
const arch = process.arch;
const extensionName = files[platform];
const packagePlatform = platform === "win32" ? "windows" : platform;
if (extensionName && !(platform === "win32" && arch === "arm64")) {
  const source = join(qmd, "node_modules", `sqlite-vec-${packagePlatform}-${arch}`, extensionName);
  if (!existsSync(source)) throw new Error(`Missing qmd SQLite extension for ${platform}-${arch}`);
  const destination = join(output, `${platform}-${arch}`);
  mkdirSync(destination, { recursive: true });
  copyFileSync(source, join(destination, extensionName));
}
copyFileSync(join(qmd, "LICENSE"), join(output, "LICENSE"));
