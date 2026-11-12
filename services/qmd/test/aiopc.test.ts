import { afterEach, beforeEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/index.js";

let directory: string;
let root: string;
let dbPath: string;
let server: Server | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "aiopc-qmd-"));
  root = join(directory, "docs");
  dbPath = join(directory, "index.sqlite");
  await mkdir(root);
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  }
  await rm(directory, { recursive: true, force: true });
});

async function write(name: string, title: string, scope: string, kind: string, body: string) {
  await writeFile(join(root, name), `---\ntitle: ${title}\nscope: ${scope}\nkind: ${kind}\naliases: [标志, 品牌标志, logo]\n---\n${body}\n`);
}

const collection = "knowledge";

async function open(embedding?: { provider: "openai" | "ollama"; baseUrl: string; model: string; dimensions?: number; apiKey?: string }) {
  const store = await createStore({ dbPath, embedding });
  await store.addCollection(collection, { path: root });
  await store.update();
  return store;
}

test("scopes and types filter mixed-language trigrams and short CJK queries before the limit", async () => {
  await write("z-alpha.md", "Alpha 品牌标志", "project:alpha", "image", "启动品牌标志 logo");
  await write("a-beta.md", "Beta 品牌标志", "project:beta", "image", "启动品牌标志 logo");
  await write("b-alpha.md", "Alpha 品牌标志", "project:alpha", "document", "启动品牌标志 logo");
  const store = await open();
  try {
    const tokenizer = store.internal.db.prepare(
      "SELECT sql FROM sqlite_master WHERE name = 'documents_fts_trigram'"
    ).get<{ sql: string }>();
    expect(tokenizer?.sql).toContain("trigram");
    const filter = {
      operator: "and" as const,
      operands: [
        { field: "scope", operator: "in" as const, value: ["project:alpha", "company"] },
        { field: "kind", operator: "eq" as const, value: "image" },
      ],
    };
    for (const query of ["品牌标志 logo", "品牌标", "标志", "标", "logo 标志", "logo标志"]) {
      const hits = await store.searchLex(query, { collection, filter, limit: 1 });
      expect(hits[0]?.displayPath, query).toBe("knowledge/z-alpha.md");
      expect(hits[0]?.metadata?.aliases).toContain("logo");
    }

    expect(await store.searchLex("%不存在_%", { collection, filter })).toEqual([]);
    await rm(join(root, "z-alpha.md"));
    await store.update();
    expect(await store.searchLex("品牌标志", { collection, filter })).toEqual([]);
    expect(await store.searchLex("标", { collection, filter })).toEqual([]);
  } finally {
    await store.close();
  }
});

test("OpenAI-compatible embedding rebuilds after equal-dimension model and same-model dimension changes", async () => {
  await write("alpha.md", "Alpha", "project:alpha", "document", "searchable report");
  await write("beta.md", "Beta", "project:beta", "document", "another report");
  const calls: { path: string; model: string; dimensions?: number; key?: string }[] = [];
  let actualDimensions = 3;
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ path: req.url!, model: body.model, dimensions: body.dimensions, key: req.headers.authorization });
    const data = body.input.map((input: string, index: number) => ({
      embedding: Array.from({ length: actualDimensions }, (_, i) => i === (input.includes("Alpha") ? 1 : 0) ? 1 : 0),
      index,
    }));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: data.reverse() }));
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  for (const [model, dimensions, reembedded] of [
    ["mock-1", 3, true],
    ["mock-1", 3, false],
    ["mock-2", 3, true],
    ["mock-2", 4, true],
  ] as const) {
    actualDimensions = dimensions;
    const store = await open({ provider: "openai", baseUrl, model, apiKey: "fixture-key" });
    try {
      const result = await store.embed();
      expect(result.errors).toBe(0);
      expect(result.docsProcessed).toBe(reembedded ? 2 : 0);
      const hits = await store.searchVector("something", {
        collection,
        filter: { field: "scope", operator: "eq", value: "project:alpha" },
      });
      expect(hits.map(hit => hit.displayPath)).toEqual(["knowledge/alpha.md"]);
      const signature = store.internal.db.prepare(
        "SELECT value FROM store_config WHERE key = 'embedding_index_signature'"
      ).get<{ value: string }>();
      expect(JSON.parse(signature!.value)).toMatchObject({ model, dimensions, provider: "openai" });
    } finally {
      await store.close();
    }
  }

  const incompatible = await open({
    provider: "openai", baseUrl, model: "incompatible", apiKey: "fixture-key", dimensions: 3,
  });
  try {
    await expect(incompatible.embed()).rejects.toThrow("invalid vectors");
    const signature = incompatible.internal.db.prepare(
      "SELECT value FROM store_config WHERE key = 'embedding_index_signature'"
    ).get<{ value: string }>();
    expect(JSON.parse(signature!.value)).toMatchObject({ model: "mock-2", dimensions: 4 });
  } finally {
    await incompatible.close();
  }

  expect(calls.every(call => call.path === "/v1/embeddings" && call.key === "Bearer fixture-key")).toBe(true);
  expect(calls.at(-1)?.dimensions).toBe(3);
});

test("Ollama batch request returns vectors without loading a GGUF model", async () => {
  await write("alpha.md", "Alpha", "project:alpha", "document", "searchable report");
  const calls: { path: string; model: string; input: string[] }[] = [];
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ path: req.url!, model: body.model, input: body.input });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ embeddings: body.input.map(() => [1, 0, 0]) }));
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const store = await open({ provider: "ollama", baseUrl: `http://127.0.0.1:${address.port}`, model: "bge-m3" });
  try {
    expect(await store.embed()).toMatchObject({ docsProcessed: 1, chunksEmbedded: 1, errors: 0 });
    expect(await store.searchVector("not a lexical match", { collection })).toHaveLength(1);
  } finally {
    await store.close();
  }
  expect(calls.every(call => call.path === "/api/embed" && call.model === "bge-m3" && Array.isArray(call.input))).toBe(true);
});

test("AIOPC worker filters over more scopes than one metadata membership group", async () => {
  await write("wanted.md", "Wanted", "project:wanted", "image", "启动品牌标志 logo");
  await write("unwanted.md", "Unwanted", "project:unwanted", "image", "启动品牌标志 logo");
  const request = {
    dbPath, root, collection, operation: "search", kind: null, query: "logo标志",
    scopes: [...Array.from({ length: 70 }, (_, i) => `project:other-${i}`), "project:wanted"],
  };
  const worker = fileURLToPath(new URL("../src/aiopc.ts", import.meta.url));
  const args = "Bun" in globalThis ? [worker] : ["--import", "tsx", worker];
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, args, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin!.end(JSON.stringify(request));
  });
  expect(JSON.parse(output)).toMatchObject([
    { source_path: "wanted.md", scope: "project:wanted", mode: "fts", frontmatter: { aliases: ["标志", "品牌标志", "logo"] } },
  ]);
});
