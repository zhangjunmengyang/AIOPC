import { applyCompanyRoleSkillsV1 } from "./company-role-skills-v1.js";
import { companyDirectoryForExecution, companyProjectInstructions } from "../company-projects.js";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { appendAgentInstructions, createInstructionSection } from "./agent-instruction-compose.js";
import { correctWorkspaceRoot, workspaceFileGuidance, workspaceFileHooks } from "./workspace-file-destinations.js";

/**
 * AIOPC Capabilities Knowledge Plugin
 *
 * Injects what AIOPC can do into the agent's system prompt (projects, models,
 * accounts, authorized folders, connections, other sessions) and serves
 * AIOPC's user guide (packages/docs) through the docs tools.
 *
 * Each rule lives in exactly one place: Connect tool mechanics are in the base
 * agent prompt, readiness in the runtime steering, app control and browser
 * mechanics in the extensions plugin, and live catalogs in their own sections.
 */

const OPENWORK_CAPABILITIES_KNOWLEDGE = `You are running inside AIOPC, a desktop workbench for one-person companies.

For questions about AIOPC itself (pages, settings, how to connect or publish), use openwork_docs_search and openwork_docs_read first; they hold AIOPC's user guide. Cite the docs-relative path (for example accounts/accounts.md) when it helps. These tools answer product questions only; never use them instead of doing the work with your tools.

What you can help users with:

## Projects
- Each workspace is a company. Its projects live under projects/<name>; a conversation can work at the company root or inside one project while remaining in the same company. Shared roles and knowledge belong to the company, and project files belong to their project. The user browses source documents, images and their relationships in 知识库. Follow the current company/project directories injected below; never infer a different company from a project conversation.

## Models
- Settings > AI Providers adds Anthropic, OpenAI, Google, OpenRouter or any OpenAI-compatible endpoint; Settings > Ollama connects local models. AIOPC offers no hosted models.

## Social accounts
- Each project has its own environment: a real Chromium on a machine of its own (a local container, or a cloud browser the person pays for), where that project's logins live. Browsing and publishing happen there; it starts by itself. The person can watch or take over from the 项目环境 panel beside the chat, or 看画面 on the Accounts page.
- The Accounts page (账号) connects platforms: every platform through a browser login done in the chat (the AI sends the QR code, or asks for the phone number and code); some also through official APIs or third-party data. Use the aiopc social tools; never ask the user for passwords or API keys in chat, point them to the account's details on the Accounts page instead.

## Authorized folders
- Settings > Permissions manages which folders AIOPC can access. When a path is "not authorized", the user adds that folder there; the UI control action \`settings.panel.open\` with \`{panel: "permissions"}\` opens it.

## Connections: skills, MCP and plugins
- The Connections page (连接) lists skills, MCP servers and plugins. Add a local or remote MCP server there.
- Skills are instruction packs for a kind of work; create them as the \`Skill creation:\` instruction in this prompt directs.
- Plugins extend the runtime with custom tools: a file in \`.opencode/plugins/\` listed in the \`plugin\` array of \`opencode.json\`.

## Other sessions
- For questions about another chat (what was said, decided, or done), use the session affordances described under the app context; match by ID, title, workspace, or topic words, ask a short clarifying question if several sessions match, and answer only from the returned transcript.
- Sidebar groups (such as Done or In progress) are listed with session.group.list and changed with session.group.create, session.group.move or session.group.remove; never search code or files for them.

When users ask what AIOPC can do, summarize these capabilities and the one-person-company work in your instructions; for a specific how-to, read the docs first, then give direct steps.`;

const docsSearchArgsSchema = z.object({
  query: z.string().min(1).describe("AIOPC docs search query, for example '连接账号'."),
  limit: z.number().int().min(1).max(10).optional().describe("Maximum number of matching docs to return."),
});

const docsReadArgsSchema = z.object({
  path: z.string().min(1).describe("Docs-relative path returned by openwork_docs_search, for example accounts/accounts.md."),
});

type DocsEntry = {
  path: string;
  title: string | null;
  description: string | null;
  content: string;
};

let docsCache: Promise<DocsEntry[]> | null = null;

function docsCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    process.env.OPENWORK_DOCS_DIR?.trim() ?? "",
    join(here, "..", "openwork-docs"),
    join(here, "..", "..", "openwork-docs"),
    resolve(here, "..", "..", "..", "..", "packages", "docs"),
    resolve(here, "..", "..", "..", "..", "..", "packages", "docs"),
  ].filter(Boolean);
}

async function existingDocsDir(): Promise<string | null> {
  for (const candidate of docsCandidates()) {
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) return candidate;
    } catch {
      // Try the next layout.
    }
  }
  return null;
}

async function docsFiles(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "images" || entry.name === "logo") continue;
      const nested = await docsFiles(root, path);
      files.push(...nested);
    } else if (entry.isFile() && /\.(md|mdx|json)$/i.test(entry.name) && entry.name !== "openapi.json") {
      files.push(path);
    }
  }
  return files;
}

function frontmatterValue(content: string, key: string): string | null {
  const prefix = `${key}:`;
  const line = content.split("\n").find((entry) => entry.startsWith(prefix));
  const raw = line?.slice(prefix.length).trim();
  if (!raw) return null;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

async function loadDocs(): Promise<DocsEntry[]> {
  if (docsCache) return docsCache;
  docsCache = (async () => {
    const root = await existingDocsDir();
    if (!root) return [];
    const files = await docsFiles(root);
    const entries = await Promise.all(files.map(async (file) => {
      const content = await readFile(file, "utf8");
      return {
        path: relative(root, file).replace(/\\/g, "/"),
        title: frontmatterValue(content, "title"),
        description: frontmatterValue(content, "description"),
        content,
      };
    }));
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  })();
  return docsCache;
}

function scoreDoc(entry: DocsEntry, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const path = entry.path.toLowerCase();
  const title = entry.title?.toLowerCase() ?? "";
  const description = entry.description?.toLowerCase() ?? "";
  const content = entry.content.toLowerCase();
  return terms.reduce((score, term) => {
    if (path.includes(term)) score += 8;
    if (title.includes(term)) score += 6;
    if (description.includes(term)) score += 4;
    if (content.includes(term)) score += 1;
    return score;
  }, 0);
}

function excerpt(content: string, query: string): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = content.toLowerCase();
  const index = terms.reduce((best, term) => {
    const next = lower.indexOf(term);
    return next >= 0 && (best < 0 || next < best) ? next : best;
  }, -1);
  const start = Math.max(0, index - 160);
  const from = index >= 0 ? start : 0;
  return content.slice(from, from + 500).replace(/\s+/g, " ").trim();
}

type Context = NonNullable<Parameters<typeof workspaceFileHooks>[0]> & { worktree?: string };

export const OpenWorkCapabilitiesKnowledge = async (context?: Context) => ({
  ...workspaceFileHooks(context),
  config: async (config: Parameters<typeof applyCompanyRoleSkillsV1>[0]) => {
    if (context?.directory) await applyCompanyRoleSkillsV1(config, context.directory, context.worktree);
  },
  "experimental.chat.system.transform": async (input: { sessionID?: string }, output: { system: string[] }) => {
    const directory = context?.directory;
    const company = directory && await companyDirectoryForExecution(directory, context?.worktree, input.sessionID);
    if (directory) correctWorkspaceRoot(output.system, directory);
    appendAgentInstructions(output.system,
      createInstructionSection("capabilities-knowledge", OPENWORK_CAPABILITIES_KNOWLEDGE),
      ...(company && directory ? [createInstructionSection("company-project", companyProjectInstructions(company, directory))] : []),
      ...(directory ? [createInstructionSection("workspace-files", workspaceFileGuidance(directory))] : []));
  },
  tool: {
    openwork_docs_search: {
      description: "Search the bundled OpenWork documentation. Use this first for OpenWork product questions before inspecting implementation code.",
      args: docsSearchArgsSchema.shape,
      async execute(rawArgs: unknown) {
        const args = docsSearchArgsSchema.parse(rawArgs);
        const docs = await loadDocs();
        const matches = docs
          .map((entry) => ({ entry, score: scoreDoc(entry, args.query) }))
          .filter((match) => match.score > 0)
          .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
          .slice(0, args.limit ?? 5)
          .map((match) => ({
            path: match.entry.path,
            title: match.entry.title,
            description: match.entry.description,
            excerpt: excerpt(match.entry.content, args.query),
          }));
        return JSON.stringify({ ok: true, matches }, null, 2);
      },
    },
    openwork_docs_read: {
      description: "Read a bundled OpenWork documentation page by docs-relative path returned from openwork_docs_search.",
      args: docsReadArgsSchema.shape,
      async execute(rawArgs: unknown) {
        const args = docsReadArgsSchema.parse(rawArgs);
        const normalized = args.path.replace(/^\/+/, "");
        if (normalized.split("/").includes("..")) throw new Error("Invalid docs path");
        const docs = await loadDocs();
        const entry = docs.find((doc) => doc.path === normalized);
        if (!entry) throw new Error(`OpenWork docs page not found: ${normalized}`);
        return JSON.stringify(entry, null, 2);
      },
    },
  },
});
