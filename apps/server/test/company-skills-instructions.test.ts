import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
  const plugin = await OpenWorkCapabilitiesKnowledge({ directory: executionDirectory, worktree: companyDirectory });
  const output = { system: ["original"] };
  await plugin["experimental.chat.system.transform"]({}, output);
  assert.match(output.system.join("\n"), /project="\/company\/projects\/design"/);
  assert.ok(!output.system.join("\n").includes("Each workspace is a project"));
  assert.match(output.system.join("\n"), /知识库/);
  const company = buildOpenWorkV2Instructions({ companyDirectory, executionDirectory: companyDirectory });
  assert.match(company.operatingInstructions, /公司级会话/);
  assert.ok(!company.operatingInstructions.includes('project="/company"'));
});

test("v1 disambiguates company roots and projects using the managed host", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiopc-v1-project-instructions-")));
  const company = join(root, "projects", "company");
  const project = join(company, "projects", "repository");
  await mkdir(project, { recursive: true });
  let bothRegistered = false;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.headers.authorization !== "Bearer instructions-fixture") {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/workspaces") {
      response.end(JSON.stringify({ items: [
        { id: "company", path: company },
        ...(bothRegistered ? [{ id: "repository", path: project }] : []),
      ] }));
    } else if (request.url === "/workspace/company/session-groups") {
      response.end(JSON.stringify({ state: { sessionMeta: { ses_project: { projectId: "proj:repository" } } } }));
    } else if (request.url === "/workspace/repository/session-groups") {
      response.end(JSON.stringify({ state: { sessionMeta: { ses_company: { projectId: null } } } }));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = new Map(["OPENWORK_SERVER_URL", "OPENWORK_SERVER_TOKEN"].map(key => [key, process.env[key]]));
  process.env.OPENWORK_SERVER_URL = `http://127.0.0.1:${address.port}`;
  process.env.OPENWORK_SERVER_TOKEN = "instructions-fixture";
  try {
    const instructions = async (directory: string, sessionID: string) => {
      // Both a company and a project with its own Git repo report their own
      // directory as worktree in the v1 native plugin context.
      const context = { directory, worktree: directory };
      const plugin = await OpenWorkCapabilitiesKnowledge(context);
      const output = { system: ["original"] };
      await plugin["experimental.chat.system.transform"]({ sessionID }, output);
      return output.system.join("\n");
    };
    const companyPrompt = await instructions(company, "ses_root");
    assert.ok(companyPrompt.includes(`当前公司目录：${JSON.stringify(company)}`), companyPrompt);
    assert.match(companyPrompt, /这是公司级会话/);
    const projectPrompt = await instructions(project, "ses_project");
    assert.ok(projectPrompt.includes(`project=${JSON.stringify(project)}`), projectPrompt);
    assert.ok(projectPrompt.includes(`当前公司目录：${JSON.stringify(company)}`), projectPrompt);
    assert.deepEqual(requests, ["/workspaces", "/workspaces"]);

    bothRegistered = true;
    const nestedCompanyPrompt = await instructions(project, "ses_company");
    assert.ok(nestedCompanyPrompt.includes(`当前公司目录：${JSON.stringify(project)}`), nestedCompanyPrompt);
    assert.match(nestedCompanyPrompt, /这是公司级会话/);
    const nestedProjectPrompt = await instructions(project, "ses_project");
    assert.ok(nestedProjectPrompt.includes(`当前公司目录：${JSON.stringify(company)}`), nestedProjectPrompt);
    assert.ok(nestedProjectPrompt.includes(`project=${JSON.stringify(project)}`), nestedProjectPrompt);
    assert.ok(!(await instructions(project, "ses_unknown")).includes("当前公司目录"));
  } finally {
    for (const [key, value] of env) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
