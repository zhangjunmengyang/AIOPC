"""Share the local qmd worker across Markdown collections."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from filelock import AsyncFileLock, Timeout

_COLLECTION_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
_WORKER_ENV = (
    "PATH", "SYSTEMROOT", "WINDIR", "TMP", "TEMP", "TMPDIR", "SSL_CERT_FILE",
    "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "AIOPC_QMD_VECTOR_EXTENSION",
)


class CollectionSearchError(ValueError):
    pass


class CollectionSearch:
    """Register trusted Markdown roots, then search with scopes chosen by the caller."""

    def __init__(self, home: Path, *, command: Sequence[str] | None = None,
                 environment: Mapping[str, str] | None = None):
        self.home = Path(home).resolve()
        self.environment = os.environ if environment is None else environment
        self.command = tuple(command) if command is not None else None
        self.roots: dict[str, Path] = {}

    def register(self, collection: str, root: Path) -> None:
        if not _COLLECTION_NAME.fullmatch(collection):
            raise CollectionSearchError("qmd 集合名称无效")
        path = Path(root).resolve()
        if self.roots.setdefault(collection, path) != path:
            raise CollectionSearchError("qmd 集合已注册到其他目录")

    async def search(self, collection: str, query: str, *, scopes: Iterable[str],
                     kind: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
        if not isinstance(query, str) or len(query) > 4000:
            raise CollectionSearchError("查询词需为 1–4000 字")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
            raise CollectionSearchError("结果数量需为 1–100")
        if kind is not None and (not isinstance(kind, str) or not kind or len(kind) > 80):
            raise CollectionSearchError("知识类型无效")
        selected = tuple(dict.fromkeys(scopes))
        if not query.strip() or not selected:
            return []
        result = await self._run(collection, selected, operation="search", query=query.strip(), kind=kind, limit=limit)
        if not isinstance(result, list):
            raise CollectionSearchError("qmd 返回了无法读取的搜索结果")
        root = self.roots[collection]
        hits = []
        for item in result:
            if not isinstance(item, dict) or item.get("scope") not in selected or not isinstance(item.get("source_path"), str):
                continue
            relative = Path(item["source_path"])
            if relative.is_absolute() or ".." in relative.parts or not (root / relative).resolve().is_relative_to(root):
                continue
            if not (root / relative).is_file() or not isinstance(item.get("frontmatter"), dict):
                continue
            if kind is not None and item["frontmatter"].get("kind") != kind:
                continue
            hits.append(item)
        return hits[:limit]

    async def refresh(self, collection: str, *, scopes: Iterable[str]) -> dict[str, Any]:
        selected = tuple(dict.fromkeys(scopes))
        if not selected:
            return {"indexed": 0}
        result = await self._run(collection, selected, operation="refresh")
        if not isinstance(result, dict):
            raise CollectionSearchError("qmd 返回了无法读取的索引结果")
        return result

    def _embedding(self) -> dict[str, Any] | None:
        env = self.environment
        provider = env.get("AIOPC_KB_EMBEDDING_PROVIDER", "").strip().lower()
        if not provider:
            return None
        if provider not in {"openai", "ollama"}:
            raise CollectionSearchError("qmd embedding 服务需为 openai 或 ollama")
        model = env.get("AIOPC_KB_EMBEDDING_MODEL", "").strip()
        default_url = "https://api.openai.com/v1" if provider == "openai" else "http://127.0.0.1:11434"
        base_url = env.get("AIOPC_KB_EMBEDDING_BASE_URL", default_url).strip().rstrip("/")
        try:
            url = urlsplit(base_url)
            if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.query or url.fragment:
                raise ValueError
            dimensions = int(env.get("AIOPC_KB_EMBEDDING_DIMENSIONS") or "0")
            if not model or not 0 <= dimensions <= 65536:
                raise ValueError
        except ValueError:
            raise CollectionSearchError("qmd embedding 地址、模型或维度配置无效") from None
        settings = {"provider": provider, "model": model, "baseUrl": base_url}
        if dimensions:
            settings["dimensions"] = dimensions
        if key := env.get("AIOPC_KB_EMBEDDING_API_KEY", "").strip():
            settings["apiKey"] = key
        return settings

    def _worker(self) -> tuple[Sequence[str], dict[str, str]]:
        configured = self.environment.get("AIOPC_QMD_RUNNER")
        if configured:
            runner = Path(configured)
        else:
            runner = Path(__file__).resolve().parents[2] / "qmd" / "src" / "aiopc.ts"
        environment = {key: os.environ[key] for key in _WORKER_ENV if key in os.environ}
        if extension := self.environment.get("AIOPC_QMD_VECTOR_EXTENSION"):
            environment["AIOPC_QMD_VECTOR_EXTENSION"] = extension
        if self.command:
            return self.command, environment
        if not runner.is_file():
            raise CollectionSearchError("找不到 qmd 搜索程序")
        if node := self.environment.get("AIOPC_QMD_NODE"):
            environment["ELECTRON_RUN_AS_NODE"] = "1"
            environment["AIOPC_QMD_NODE_SQLITE"] = "1"
            return (node, str(runner)), environment
        return (self.environment.get("AIOPC_QMD_BUN") or "bun", str(runner)), environment

    async def _run(self, collection: str, scopes: tuple[str, ...], **options) -> Any:
        if not all(isinstance(scope, str) and scope and len(scope) <= 256 for scope in scopes):
            raise CollectionSearchError("qmd 作用域无效")
        root = self.roots.get(collection)
        if root is None:
            raise CollectionSearchError("qmd 集合未注册")
        if not root.is_dir():
            raise CollectionSearchError("qmd 集合目录不存在")
        index_directory = self.home / "qmd"
        index_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        digest = hashlib.sha256(f"{collection}\0{root}".encode()).hexdigest()
        db_path = index_directory / f"{digest}.sqlite"
        request = {"dbPath": str(db_path), "collection": collection, "root": str(root), "scopes": scopes, **options}
        if embedding := self._embedding():
            request["embedding"] = embedding
        command, environment = self._worker()
        try:
            async with AsyncFileLock(str(db_path) + ".lock", timeout=105, run_in_executor=False):
                worker = await asyncio.create_subprocess_exec(
                    *command, cwd=index_directory, env=environment, stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                )
                try:
                    stdout, _ = await asyncio.wait_for(
                        worker.communicate(json.dumps(request, ensure_ascii=False).encode()), timeout=105,
                    )
                finally:
                    if worker.returncode is None:
                        try:
                            worker.kill()
                        except ProcessLookupError:
                            pass
                        await worker.wait()
                if worker.returncode != 0:
                    raise CollectionSearchError("qmd 未完成检索。请检查本地运行环境和 embedding 配置")
                return json.loads(stdout)
        except (Timeout, TimeoutError):
            raise CollectionSearchError("qmd 检索超时。索引较大时可先从知识库页面重建索引") from None
        except OSError:
            raise CollectionSearchError("无法运行 qmd 搜索程序") from None
        except (UnicodeError, json.JSONDecodeError):
            raise CollectionSearchError("qmd 返回了无法读取的结果") from None
