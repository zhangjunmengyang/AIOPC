import { existsSync } from "node:fs";
import path from "node:path";

const extensionNames = {
  darwin: "vec0.dylib",
  linux: "vec0.so",
  win32: "vec0.dll",
};

export function configureAiopcQmd({
  app, desktopRoot, resourcesPath = process.resourcesPath, platform = process.platform,
  arch = process.arch, env = process.env, node = process.execPath, exists = existsSync,
}) {
  if (env.AIOPC_QMD_RUNNER) return true;
  const directory = app.isPackaged
    ? path.join(resourcesPath, "aiopc-qmd")
    : path.join(desktopRoot, "dist", "aiopc-qmd");
  const runner = path.join(directory, "aiopc-qmd.mjs");
  if (!exists(runner)) return false;
  env.AIOPC_QMD_RUNNER = runner;
  env.AIOPC_QMD_NODE = node;
  const name = extensionNames[platform];
  if (name) {
    const extension = path.join(directory, `${platform}-${arch}`, name);
    if (exists(extension)) env.AIOPC_QMD_VECTOR_EXTENSION = extension;
  }
  return true;
}
