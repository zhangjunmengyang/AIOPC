/** Build AIOPC's small v1 MCP metadata fork. The installed application is never modified. */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const OPENCODE_SOURCE_COMMIT = "51ef4be1d3c122f18fefb510dca8d778571f4f18";
export const OPENCODE_SOURCE_VERSION = "1.18.33";
const directory = dirname(fileURLToPath(import.meta.url));
const patchFile = join(directory, "patches/opencode-v1-session-metadata.patch");
const verifyFile = join(directory, "patches/verify-session-metadata.fixture.ts");

async function run(command, args, cwd, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)));
  });
}

export async function prepareAiopcOpencode(outdir, { sourceDirectory = process.env.AIOPC_OPENCODE_SOURCE_DIR, version = OPENCODE_SOURCE_VERSION, targetTriple } = {}) {
  if (version.replace(/^v/, "") !== OPENCODE_SOURCE_VERSION) throw new Error("AIOPC MCP metadata patch must be reviewed before changing the v1 sidecar version");
  const nativeTriple = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : process.platform === "win32" ? "pc-windows-msvc" : "unknown-linux-gnu"}`;
  if (targetTriple && targetTriple !== nativeTriple) throw new Error(`Build the patched v1 runtime on its target platform (${targetTriple}); current builder is ${nativeTriple}`);
  const patch = await readFile(patchFile);
  const key = createHash("sha256").update(OPENCODE_SOURCE_COMMIT).update(patch).update(`${process.platform}/${process.arch}`).digest("hex");
  const destination = join(resolve(outdir), process.platform === "win32" ? "opencode.exe" : "opencode");
  const stampFile = `${destination}.aiopc.json`;
  try {
    const stamp = JSON.parse(await readFile(stampFile, "utf8"));
    if (stamp.key === key && stamp.sha256 === createHash("sha256").update(await readFile(destination)).digest("hex")) return destination;
  } catch { /* No verified local fork yet. */ }
  const workspace = sourceDirectory ? resolve(sourceDirectory) : await mkdtemp(join(tmpdir(), "aiopc-opencode-build-"));
  if (!sourceDirectory) {
    const archive = join(workspace, "source.tar.gz");
    await run("curl", ["--fail", "--location", "--retry", "2", "--output", archive, `https://codeload.github.com/anomalyco/opencode/tar.gz/${OPENCODE_SOURCE_COMMIT}`], workspace);
    await run("tar", ["-xzf", archive, "--strip-components=1", "-C", workspace], workspace);
    await rm(archive);
  }
  // A failed context check aborts the build instead of silently shipping an unpatched runtime.
  const marker = join(workspace, ".aiopc-session-metadata-patch");
  let applied = false;
  try { applied = (await readFile(marker, "utf8")) === key; } catch { /* First build. */ }
  if (!applied) {
    await run("git", ["apply", "--check", patchFile], workspace);
    await run("git", ["apply", patchFile], workspace);
    await writeFile(marker, key);
  }
  // Use the upstream build tool version. Newer Bun releases changed dependency patch application.
  const bun = process.env.AIOPC_OPENCODE_BUILD_BUN;
  const command = bun || (process.platform === "win32" ? "npx.cmd" : "npx");
  const prefix = bun ? [] : ["--yes", "bun@1.3.14"];
  await run(command, [...prefix, "install", "--frozen-lockfile", "--ignore-scripts"], workspace);
  await copyFile(verifyFile, join(workspace, "packages/opencode/test/mcp/aiopc-session-metadata.test.ts"));
  const env = { ...process.env, OPENCODE_VERSION: OPENCODE_SOURCE_VERSION, OPENCODE_CHANNEL: "latest" };
  await run(command, [...prefix, "test", "test/mcp/aiopc-session-metadata.test.ts"], join(workspace, "packages/opencode"), env);
  await run(command, [...prefix, "run", "script/build.ts", "--single", "--skip-install", "--skip-embed-web-ui"], join(workspace, "packages/opencode"), env);
  const target = `opencode-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const binary = await readFile(join(workspace, `packages/opencode/dist/${target}/bin/opencode`));
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, binary, { mode: 0o755 });
  await chmod(temporary, 0o755);
  await rename(temporary, destination);
  await writeFile(stampFile, JSON.stringify({ key, source: OPENCODE_SOURCE_COMMIT, version: OPENCODE_SOURCE_VERSION, sha256: createHash("sha256").update(binary).digest("hex") }, null, 2) + "\n");
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2];
  if (!output) throw new Error("Usage: node prepare-aiopc-opencode.mjs <sidecar-output-directory>");
  await prepareAiopcOpencode(output);
}
