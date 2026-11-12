import { createHash } from "node:crypto";

export type EmbeddingProviderConfig = {
  provider: "openai" | "ollama";
  /** OpenAI-compatible base URL usually ends in /v1. Ollama uses the server root. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  dimensions?: number;
};

export type EmbeddingProvider = {
  provider: EmbeddingProviderConfig["provider"];
  model: string;
  indexKey: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
};

export const EXTERNAL_EMBEDDING_PREFIX = "qmd-external:";

export function embeddingFromEnvironment(env = process.env): EmbeddingProviderConfig | undefined {
  const provider = env.QMD_EMBED_PROVIDER?.trim();
  if (!provider) return undefined;
  if (provider !== "openai" && provider !== "ollama") {
    throw new Error("QMD_EMBED_PROVIDER must be 'openai' or 'ollama'");
  }
  return {
    provider,
    baseUrl: env.QMD_EMBED_BASE_URL || (provider === "ollama" ? "http://127.0.0.1:11434" : "https://api.openai.com/v1"),
    model: env.QMD_EMBED_MODEL || "",
    apiKey: env.QMD_EMBED_API_KEY,
    dimensions: env.QMD_EMBED_DIMENSIONS ? Number(env.QMD_EMBED_DIMENSIONS) : undefined,
  };
}

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  const { provider, dimensions, apiKey } = config;
  const model = config.model?.trim();
  if (!model || (provider !== "openai" && provider !== "ollama")) {
    throw new Error("An external embedding provider and model are required");
  }
  if (dimensions !== undefined && (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 8192)) {
    throw new Error("Embedding dimensions must be an integer between 1 and 8192");
  }
  const baseUrl = new URL(config.baseUrl);
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error("Embedding endpoint must be an HTTP(S) base URL without credentials or query parameters");
  }
  const path = provider === "openai" ? "/embeddings" : "/api/embed";
  const endpoint = baseUrl.href.replace(/\/+$/, "") + path;
  const key = createHash("sha256").update(JSON.stringify([provider, endpoint, model, dimensions])).digest("hex");
  return {
    provider,
    model,
    indexKey: EXTERNAL_EMBEDDING_PREFIX + key,
    async embed(input, signal) {
      if (input.length === 0) return [];
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(30_000);
        response = await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ model, input, dimensions }),
        });
      } catch {
        throw new Error("Embedding provider request failed");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Embedding provider returned HTTP ${response.status}`);
      }
      const payload = await response.json().catch(() => null) as {
        embeddings?: unknown;
        data?: { index?: number; embedding?: unknown }[];
      } | null;
      const vectors = provider === "openai"
        ? Array.isArray(payload?.data) && payload.data.length === input.length
          ? orderedOpenAiVectors(payload.data)
          : undefined
        : payload?.embeddings;
      if (!Array.isArray(vectors) || vectors.length !== input.length ||
          !vectors.every(vector => validVector(vector, dimensions ?? vectors[0]?.length))) {
        throw new Error("Embedding provider returned invalid vectors");
      }
      return vectors;
    },
  };
}

function orderedOpenAiVectors(rows: { index?: number; embedding?: unknown }[]): unknown[] {
  // Some compatible servers omit indices, returning input order. Official
  // responses include them, so reorder before assigning vectors to chunks.
  if (rows.every(row => row?.index === undefined)) return rows.map(row => row?.embedding);
  const byIndex = new Map(rows.map(row => [row?.index, row?.embedding]));
  return Array.from({ length: rows.length }, (_, index) => byIndex.get(index));
}

function validVector(vector: unknown, dimensions: number | undefined): vector is number[] {
  return Array.isArray(vector) && vector.length > 0 && vector.length <= 8192 &&
    vector.length === dimensions &&
    vector.every(value => typeof value === "number" && Number.isFinite(Math.fround(value))) &&
    vector.some(value => Math.fround(value) !== 0);
}
