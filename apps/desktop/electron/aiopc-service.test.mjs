import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { aiopcServerArgs, createAiopcService, writeAuthorizedCompanies, writeAiopcHttpConnection } from "./aiopc-service.mjs";
import { createWorkspaceStore } from "./workspace-store.mjs";

test("OPC HTTP service runs Python in isolated mode", () => {
  assert.deepEqual(aiopcServerArgs("/service", 18800), ["run", "--project", "/service", "--frozen", "--no-dev", "--quiet", "python", "-I", "-B", "-m", "aiopc.server", "--port", "18800"]);
});

test("bootstrap state normalization can publish roots without deadlocking authorization refresh", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "aiopc-auth-refresh-")));
  const company = path.join(root, "company"); await mkdir(company);
  let service;
  service = createAiopcService({ app: { getPath: () => root, isPackaged: false }, desktopRoot: root,
    workspaceStore: { async listLocalWorkspacePaths() { await service.syncAuthorizedRoots([company]); return [company]; } } });
  let timeout;
  try {
    await Promise.race([service.syncAuthorizedRoots(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("authorization deadlock")), 200); })]);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, "aiopc-authorized-companies.json"), "utf8")).roots, [company]);
  } finally { clearTimeout(timeout); await rm(root, { recursive: true, force: true }); }
});

test("workspace mutations publish the new trusted roots before returning", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "aiopc-workspace-publish-")));
  const changes = [];
  const store = createWorkspaceStore({ app: { getPath: () => root }, onWorkspaceStateChanged: async state => { changes.push(state.workspaces.map(item => item.path)); } });
  try {
    await store.writeWorkspaceState({ workspaces: [{ id: "a", path: "/company-a" }] });
    await store.writeWorkspaceState({ workspaces: [] });
    assert.deepEqual(changes, [["/company-a"], []]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("trusted companies file is private, canonical, deduplicated and replaces removed authorizations", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "aiopc-authorized-")));
  const company = path.join(root, "company"), alias = path.join(root, "alias"), file = path.join(root, "private", "companies.json");
  await mkdir(company); await symlink(company, alias);
  try {
    await writeAuthorizedCompanies(file, [company, alias, path.join(root, "missing"), "https://remote.example", "relative"]);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1, roots: [company] });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await writeAuthorizedCompanies(file, []);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1, roots: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("HTTP discovery is private and records the actual local service connection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiopc-http-discovery-"));
  const file = path.join(root, "private", "aiopc-http.json");
  try {
    await writeAiopcHttpConnection(file, { url: "http://127.0.0.1:18801", token: "private-token" });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { url: "http://127.0.0.1:18801", token: "private-token" });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});
