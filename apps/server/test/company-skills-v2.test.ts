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
  let beforePrompt: (() => Promise<void>) | undefined;
  let registrations = 0;
  try {
    const dispose = await plugin.setup({ location: { directory: project }, options: { trustedDirectories: [bundle] },
      session: { async hook(_name, callback) { beforePrompt = callback; return { async dispose() {} }; } },
      skill: { async transform(callback) { registrations++; callback({ list: () => values, remove: id => { removed.push(id); } }); return { async dispose() {} }; } } });
    assert.deepEqual(removed.sort(), ["2", "3", "5"]);
    assert.ok(beforePrompt, "refresh the final registry after native filesystem sources have loaded");
    await beforePrompt();
    assert.equal(registrations, 2);
    await dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});
