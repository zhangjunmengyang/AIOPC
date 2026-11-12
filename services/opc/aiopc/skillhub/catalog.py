"""Read the bilingual AIOPC-skills catalog without dereferencing any URL."""

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import unquote, urlsplit

CatalogKind = Literal["skill", "repository", "tree", "reference", "external"]
_SLUG_PART = re.compile(r"[a-zA-Z0-9_.-]+\Z")
_LANGUAGES = ("en", "zh")


@dataclass(frozen=True)
class CatalogEntry:
    url: str
    repository: str | None
    ref: str | None
    path: str | None
    kind: CatalogKind
    names: dict[str, tuple[str, ...]]
    descriptions: dict[str, tuple[str, ...]]
    categories: tuple[str, ...]


def canonical_repository(slug: str) -> str | None:
    parts = slug.split("/")
    if len(parts) == 2 and all(_SLUG_PART.fullmatch(part) and part not in {".", ".."} for part in parts):
        return slug.lower()
    return None


def _source(url: str) -> tuple[str | None, str | None, str | None, CatalogKind]:
    try:
        parsed = urlsplit(url)
        parts = [unquote(part, errors="strict") for part in parsed.path.strip("/").split("/")]
    except ValueError:
        return None, None, None, "external"
    if parsed.scheme != "https" or parsed.netloc.lower() != "github.com" or len(parts) < 2:
        return None, None, None, "external"
    repository = canonical_repository(f"{parts[0]}/{parts[1].removesuffix('.git')}")
    if repository is None:
        return None, None, None, "reference"
    if len(parts) == 2:
        return repository, "HEAD", None, "repository"
    if len(parts) >= 4 and parts[2] in {"blob", "tree"}:
        ref, files = parts[3], parts[4:]
        if any(part in {"", ".", ".."} or "/" in part or "\\" in part or "\0" in part for part in [ref, *files]):
            return repository, None, None, "reference"
        if parts[2] == "tree":
            return repository, ref, "/".join(files) or None, "tree"
        if files and files[-1] == "SKILL.md":
            return repository, ref, "/".join(files), "skill"
    return repository, None, None, "reference"


def _bilingual(entries: dict, field: str) -> dict[str, tuple[str, ...]]:
    return {
        language: tuple(dict.fromkeys(value for entry in entries.get(language, []) if isinstance(value := entry.get(field), str) and value))
        for language in _LANGUAGES
    }


def _categories(sources: dict) -> tuple[str, ...]:
    categories = set()
    for language in _LANGUAGES:
        prefix = f"docs/{language}/"
        for source in sources.get(language, []):
            if source.startswith(prefix) and source.endswith(".md"):
                categories.add(source.removeprefix(prefix).removesuffix(".md"))
    return tuple(sorted(categories))


def load_catalog(path: Path) -> list[CatalogEntry]:
    with path.open(encoding="utf-8") as file:
        catalog = json.load(file)
    if not isinstance(catalog, dict) or catalog.get("schema_version") != 2 or not isinstance(catalog.get("resources"), list):
        raise ValueError("Expected version 2 of the AIOPC-skills catalog")
    result = []
    for row in catalog["resources"]:
        url = row["url"]
        repository, ref, source_path, kind = _source(url)
        entries = row.get("entries", {})
        result.append(CatalogEntry(
            url=url,
            repository=repository,
            ref=ref,
            path=source_path,
            kind=kind,
            names=_bilingual(entries, "name"),
            descriptions=_bilingual(entries, "description"),
            categories=_categories(row.get("sources", {})),
        ))
    return result
