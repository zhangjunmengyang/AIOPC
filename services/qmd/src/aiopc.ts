/** Process boundary between AIOPC's collection registry and the qmd SDK. */
import { isAbsolute } from "node:path";
import { z } from "zod";
import { createStore, type ExpandedQuery, type MetadataFilter } from "./index.js";
import { validateLexQuery, validateSemanticQuery } from "./store.js";
import { METADATA_FILTER_LIMITS } from "./metadata-filter.js";
import { readFrontmatter, stripFrontmatter } from "./metadata.js";

const { maxMembershipValues, maxGroupOperands } = METADATA_FILTER_LIMITS;

const requestSchema = z.object({
  operation: z.enum(["search", "refresh"]).default("search"),
  dbPath: z.string().refine(isAbsolute),
  root: z.string().refine(isAbsolute),
  collection: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  query: z.string().trim().max(4096).optional(),
  scopes: z.array(z.string().min(1).max(1024)).max(maxMembershipValues * maxGroupOperands),
  kind: z.string().min(1).max(1024).nullish(),
  limit: z.number().int().min(1).max(100).default(10),
  embedding: z.object({
    provider: z.enum(["openai", "ollama"]),
    baseUrl: z.string(),
    model: z.string(),
    apiKey: z.string().optional(),
    dimensions: z.number().int().optional(),
  }).optional(),
});

async function run(request: z.output<typeof requestSchema>): Promise<unknown> {
  const { dbPath, collection, root, scopes, kind, limit, embedding } = request;
  const query = request.query?.replace(/\s+/g, " ");
  if (request.operation === "search" && (!query || !scopes.length)) return [];

  const warnings: string[] = [];
  let store;
  try {
    store = await createStore({ dbPath, embedding });
  } catch (error) {
    if (!embedding) throw error;
    store = await createStore({ dbPath });
    warnings.push("Embedding configuration is unavailable. Using keyword search.");
  }
  try {
    await store.addCollection(collection, { path: root, pattern: "**/*.{md,markdown,mdx}" });
    const update = await store.update({ collections: [collection] });
    let mode: "hybrid" | "fts" = "fts";
    if (embedding && !warnings.length) {
      try {
        const embedded = await store.embed({ collection });
        if (embedded.errors > 0) throw new Error("Incomplete embedding index");
        mode = "hybrid";
      } catch {
        warnings.push("Embedding provider or vector index is unavailable. Using keyword search.");
      }
    }
    if (request.operation === "refresh") return { ...update, mode, warnings };

    const scopeGroups: MetadataFilter[] = [];
    const allowedScopes = new Set(scopes);
    const uniqueScopes = [...allowedScopes];
    for (let start = 0; start < uniqueScopes.length; start += maxMembershipValues) {
      scopeGroups.push({ field: "scope", operator: "in", value: uniqueScopes.slice(start, start + maxMembershipValues) });
    }
    const scopeFilter: MetadataFilter = scopeGroups.length === 1
      ? scopeGroups[0]!
      : { operator: "or", operands: scopeGroups };
    const filter: MetadataFilter = kind
      ? { operator: "and", operands: [scopeFilter, { field: "kind", operator: "eq", value: kind }] }
      : scopeFilter;
    const lexQuery = validateLexQuery(query!) ? query!.replace(/"/g, "") : query!;
    const lexical: ExpandedQuery = { type: "lex", query: lexQuery };
    const search = (queries: ExpandedQuery[]) => store.search({
      queries, collection, filter, limit, candidateLimit: Math.max(40, limit), rerank: false,
    });
    if (validateSemanticQuery(query!)) mode = "fts";
    let results;
    try {
      results = await search(mode === "hybrid" ? [lexical, { type: "vec", query: query! }] : [lexical]);
    } catch (error) {
      if (mode === "fts") throw error;
      mode = "fts";
      warnings.push("Embedding provider is unavailable for this query. Using keyword search.");
      results = await search([lexical]);
    }
    const prefix = `${collection}/`;

    return results.flatMap(hit => {
      const scope = hit.metadata?.scope;
      if (typeof scope !== "string" || !allowedScopes.has(scope) || !hit.displayPath.startsWith(prefix)) return [];
      const frontmatter = readFrontmatter(hit.body);
      const title = frontmatter.title ?? frontmatter.name;
      const excerpt = hit.bestChunkPos ? hit.bestChunk : stripFrontmatter(hit.bestChunk);
      return [{
        source_path: hit.displayPath.slice(prefix.length),
        title: typeof title === "string" && title.trim() ? title.trim() : hit.title,
        snippet: excerpt.trim().slice(0, 360),
        scope,
        score: hit.score,
        frontmatter,
        mode,
        warnings,
      }];
    });
  } finally {
    await store.close();
  }
}

try {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1024 * 1024) throw new Error("qmd request exceeds 1 MB");
  }
  const request = requestSchema.safeParse(JSON.parse(input));
  if (!request.success) throw new Error("Invalid qmd request");
  process.stdout.write(JSON.stringify(await run(request.data)) + "\n");
} catch (error) {
  // JSON parser errors may echo credentials sent on stdin. Do not print them.
  process.stderr.write(error instanceof SyntaxError ? "Invalid qmd JSON\n" : `${error instanceof Error ? error.message : "qmd request failed"}\n`);
  process.exitCode = 1;
}
