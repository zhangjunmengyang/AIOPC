import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listSkills } from "../src/skills.js";
import { buildOpenWorkV2Instructions } from "../src/opencode-v2-instructions.js";
import { OpenWorkCapabilitiesKnowledge } from "../src/opencode-plugins/openwork-capabilities-knowledge.js";

test("project skill discovery includes company skills and excludes sibling and outer company skills", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiopc-company-skills-")));
  const company = join(root, "company");
  const project = join(company, "projects", "A");
  const skill = async (directory: string, name: string, description: string) => {
    const folder = join(directory, ".opencode", "skills", name);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
  };
  try {
    await skill(root, "outside", "outside");
    await skill(company, "shared", "company");
    await skill(project, "shared", "project override");
    await skill(project, "project-only", "project");
    await skill(join(company, "projects", "B"), "sibling", "sibling");
    await mkdir(join(project, ".git"));
    const skills = await listSkills(project, false, company);
    assert.deepEqual(skills.map(item => item.name).sort(), ["project-only", "shared"]);
    assert.equal(skills.find(item => item.name === "shared")?.description, "project override");
    await skill(company, "company-only", "company");
    assert.ok((await listSkills(project, false, company)).some(item => item.name === "company-only"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v1 and v2 instructions carry the actual project and company without global environment changes", async () => {
  const companyDirectory = "/company";
  const executionDirectory = "/company/projects/design";
  const v2 = buildOpenWorkV2Instructions({ companyDirectory, executionDirectory });
  assert.match(v2.operatingInstructions, /当前公司目录："\/company"/);
  assert.match(v2.operatingInstructions, /project="\/company\/projects\/design"/);
  const plugin = await OpenWorkCapabilitiesKnowledge({ directory: executionDirectory });
  const output = { system: ["original"] };
  await plugin["experimental.chat.system.transform"]({}, output);
  assert.match(output.system.join("\n"), /project="\/company\/projects\/design"/);
  assert.ok(!output.system.join("\n").includes("Each workspace is a project"));
  assert.match(output.system.join("\n"), /知识库/);
  const company = buildOpenWorkV2Instructions({ companyDirectory, executionDirectory: companyDirectory });
  assert.match(company.operatingInstructions, /公司级会话/);
  assert.ok(!company.operatingInstructions.includes('project="/company"'));
});
