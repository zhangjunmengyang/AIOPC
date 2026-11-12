"""Search the skills collection through the knowledge layer's collection API."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol

from .manifest import read_skills

SKILLS_COLLECTION = "skills"


class CollectionSearch(Protocol):
    async def search(
        self, collection: str, query: str, *, scopes: Sequence[str], kind: str | None = None, limit: int = 10,
    ) -> Sequence[Mapping[str, Any]]:
        """Return results with source_path, title, snippet, scope, score and frontmatter."""


class SkillHub:
    def __init__(self, library: Path, searcher: CollectionSearch):
        self.root = library.resolve()
        self.index_root = self.root / "skills-index"
        self.searcher = searcher

    async def find_skill(self, query: str) -> dict:
        query = query.strip()
        if not query or len(query) > 1024:
            raise ValueError("技能检索需要 1 至 1024 个字符")
        records = await asyncio.to_thread(read_skills, self.root)
        if not records:
            return {"candidates": [], "indexed": False}
        hits = await self.searcher.search(SKILLS_COLLECTION, query, scopes=("skills",), kind="skill", limit=5)
        candidates = []
        seen = set()
        for hit in hits:
            metadata = hit.get("frontmatter")
            if hit.get("scope") != "skills" or not isinstance(metadata, Mapping):
                continue
            identifier = metadata.get("id")
            if not isinstance(identifier, str) or identifier in seen:
                continue
            record = records.get(identifier)
            if not record or record.id != identifier or metadata.get("content_hash") != record.content_hash:
                continue
            if not _matches_index(hit.get("source_path"), self.index_root, identifier):
                continue
            seen.add(identifier)
            candidates.append({
                "id": identifier, "title": record.title, "source_url": record.source_url, "commit": record.commit,
                "names": {lang: list(items) for lang, items in record.names.items()},
                "descriptions": {lang: list(items) for lang, items in record.descriptions.items()},
                "categories": list(record.categories), "license": record.license, "has_scripts": record.has_scripts,
                "execution": "sandbox-only" if record.has_scripts else "instructions",
                "specification": record.specification.status, "scan": record.scan.status,
                "snippet": hit.get("snippet", ""), "score": hit.get("score"),
            })
            if len(candidates) == 5:
                break
        return {"candidates": candidates, "indexed": True}


def _matches_index(source: Any, root: Path, identifier: str) -> bool:
    if not isinstance(source, (str, Path)) or not source:
        return False
    expected = root / f"{identifier}.md"
    path = Path(source)
    if not path.is_absolute():
        path = root / path
    try:
        return path.resolve(strict=True) == expected and expected.is_file()
    except (OSError, RuntimeError, ValueError):
        return False
