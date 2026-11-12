# qmd 上游

- 仓库 [tobi/qmd](https://github.com/tobi/qmd)
- 同步点 [86d2365d17fc682e491c2c53d1e4a884aee8682a](https://github.com/tobi/qmd/commit/86d2365d17fc682e491c2c53d1e4a884aee8682a)，版本 2.8.3
- 许可证 MIT，见 [LICENSE](LICENSE)

AIOPC 在这个目录维护 fork。Markdown 仍由调用方管理，qmd 保存可重建的 SQLite 索引。AIOPC 通过 `src/aiopc.ts` 的 stdin/stdout JSON 接口调用 SDK。接入点复用 qmd 的集合刷新、元数据过滤、BM25、sqlite-vec 和 RRF。AIOPC 默认不下载 GGUF。配置外部 embedding 后启用混合检索，服务不可用时回退到词法检索。

## 本地运行

```sh
bun install --frozen-lockfile --ignore-scripts
CI=true bun test test/aiopc.test.ts
bun run test:types
```

SDK 通过 `createStore({ dbPath, embedding })` 配置 provider。CLI `qmd embed` 读取 `QMD_EMBED_PROVIDER`（`openai` 或 `ollama`）、`QMD_EMBED_MODEL`、`QMD_EMBED_BASE_URL`，并支持可选的 `QMD_EMBED_API_KEY`、`QMD_EMBED_DIMENSIONS`。OpenAI 兼容端点使用 `/embeddings`，Ollama 使用 `/api/embed`。命令先获取实际维度。provider、模型、端点或维度发生变化时，重建同一索引中的所有向量。

`src/aiopc.ts` 可用 Bun 直接运行。打包时可构建 Node ESM，设置 `AIOPC_QMD_NODE_SQLITE=1` 使用 Node 内置 SQLite，设置 `AIOPC_QMD_VECTOR_EXTENSION` 指向目标平台的 sqlite-vec 动态库。

## 同步时核对

- `src/embedding-provider.ts`、`src/llm.ts` 和 `src/store.ts` 中的 provider 选择、向量签名和索引重建。
- `src/cjk-fts.ts` 和 `src/store.ts` 中的 trigram 索引、短词 LIKE 以及作用域过滤。
- `src/metadata.ts` 中 sidecar 顶层字段映射。Markdown 原文里的中英文别名参与检索。
- `src/aiopc.ts`、`src/node-sqlite.ts` 和 `test/aiopc.test.ts` 中的 AIOPC 进程接口、运行时兼容和回归用例。
