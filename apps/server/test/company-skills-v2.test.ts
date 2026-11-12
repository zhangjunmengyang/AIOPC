import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import plugin from "../src/opencode-plugins/openwork-company-skills-v2.js";
import { renderOpencodeV2Config } from "../src/managed-opencode-v2.js";
import { pathToFileURL } from "node:url";

test("managed v2 config installs the company skill transform with only explicitly trusted paths", () => {
  const result = renderOpencodeV2Config({ providers: [], skills: ["/trusted/bundle"], companySkillsPluginDirectory: "/plugins/company-skills" });
  assert.deepEqual(result.plugins, [{ package: pathToFileURL("/plugins/company-skills").href, options: { trustedDirectories: ["/trusted/bundle"] } }]);
});

test("native v2 skill registry keeps company/current project/bundled skills and removes other filesystem scopes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiopc-v2-skill-scope-")));
  const company = join(root, "company"), project = join(company, "projects", "A"), bundle = join(root, "bundle");
  const files = [join(company, ".opencode", "skills", "shared.md"), join(project, "own.md"),
    join(company, "projects", "B", "sibling.md"), join(root, "outside.md"), join(bundle, "trusted.md")];
  for (const file of files) { await mkdir(join(file, ".."), { recursive: true }); await writeFile(file, "skill"); }
  const link = join(project, "linked.md"); await symlink(files[3]!, link);
  const values = [...files, link, "skill://opencode/SKILL.md"].map((path, index) => ({ id: String(index), path }));
  const removed: string[] = [];
  let beforePrompt: ((event: { sessionID: string; prompt: { skills?: readonly { id: string }[] } }) => Promise<void>) | undefined;
  let registrations = 0;
  try {
    const dispose = await plugin.setup({ location: { directory: project }, options: { trustedDirectories: [bundle] },
      session: { async hook(_name, callback) { beforePrompt = callback; return { async dispose() {} }; } },
      skill: { async transform(callback) { registrations++; callback({ list: () => values, remove: id => { removed.push(id); } }); return { async dispose() {} }; } } });
    assert.deepEqual(removed.sort(), ["2", "3", "5"]);
    assert.ok(beforePrompt, "refresh the final registry after native filesystem sources have loaded");
    await beforePrompt({ sessionID: "ses_unassigned", prompt: {} });
    assert.equal(registrations, 2);
    await dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native v2 role permissions deny by default and preserve named allows per agent", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiopc-v2-role-policy-")));
  const company = join(root, "company"), project = join(company, "projects", "A");
  const directory = join(company, ".opencode", "agent");
  await mkdir(directory, { recursive: true });
  for (const [id, skill] of [["design", "naming"], ["growth", "editorial"]]) {
    await writeFile(join(directory, `${id}.md`), `---\nmode: primary\nmetadata:\n  aiopc:\n    skills: [${skill}]\n---\nRole.\n`);
  }
  const files = [[company, "naming"], [company, "editorial"], [project, "adopted"], [project, "unlocked"]].map(([scope, id]) =>
    ({ id: id!, path: join(scope!, ".opencode", "skills", id!, "SKILL.md") }));
  for (const file of files) { await mkdir(join(file.path, ".."), { recursive: true }); await writeFile(file.path, "skill"); }
  await writeFile(join(project, ".opencode", "skills-lock.json"), JSON.stringify({ version: 1, skills: { adopted: { id: "adopted", hash: "a".repeat(64) } } }));
  const initial = ["design", "growth", "build"].map(id => ({ id, permissions: [{ action: "skill", resource: "*", effect: "allow" as const }] }));
  const agents = structuredClone(initial);
  let beforePrompt: ((event: { sessionID: string; prompt: { skills: Array<{ id: string }> } }) => Promise<void>) | undefined;
  try {
    const dispose = await plugin.setup({ location: { directory: project },
      session: { async get() { return { agent: "design" }; }, async hook(_name, callback) { beforePrompt = callback; return { async dispose() {} }; } },
      skill: { async list() { return { data: files }; }, async transform(callback) { callback({ list: () => files, remove() {} }); return { async dispose() {} }; } },
      agent: { async transform(callback) {
        const mutable: Array<{ id: string; permissions: Array<{ action: string; resource: string; effect: "allow" | "ask" | "deny" }> }> = structuredClone(initial);
        callback({ list: () => mutable, update(id, update) { update(mutable.find(item => item.id === id)!); } });
        agents.splice(0, agents.length, ...mutable as typeof initial);
        return { async dispose() {} };
      } },
    });
    assert.ok(beforePrompt);
    await beforePrompt({ sessionID: "ses_design", prompt: { skills: [{ id: "adopted" }] } });
    assert.deepEqual(agents.map(agent => [agent.id, agent.permissions.slice(1).map(rule => `${rule.resource}:${rule.effect}`)]), [
      ["design", ["*:deny", "naming:allow", "adopted:allow"]],
      ["growth", ["*:deny", "editorial:allow", "adopted:allow"]],
      ["build", []],
    ]);
    await assert.rejects(beforePrompt({ sessionID: "ses_design", prompt: { skills: [{ id: "editorial" }] } }), /editorial/);
    await dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});
