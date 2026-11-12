"""Company and project knowledge. Markdown owns metadata and qmd owns search."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
from contextlib import asynccontextmanager
from itertools import zip_longest
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from filelock import FileLock
from filelock import Timeout as FileLockTimeout
from markdown_it import MarkdownIt

from aiopc.knowledge_markdown import (
    MARKDOWN_SUFFIXES,
    MAX_FRONTMATTER,
    MAX_NOTE_READ,
    MEDIA_KINDS,
    markdown_bytes,
    read_markdown,
    replace_bytes,
    values,
)
from aiopc.knowledge_parse import MAX_FILE_BYTES, parse_document
from aiopc.space import KINDS, SpaceCatalog, kind_of

PARSE_VERSION = 2
SUPPORTED_TEXT = MARKDOWN_SUFFIXES | {".txt", ".csv", ".rst", ".html", ".htm", ".json", ".pdf", ".docx", ".pptx", ".xlsx"}
IMPORT_SUFFIXES = SUPPORTED_TEXT | set.union(*(KINDS[kind] for kind in MEDIA_KINDS))
QUERY_SCOPES = {"project", "company", "all", "skills"}


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_json(path: Path, value: dict) -> None:
    replace_bytes(path, json.dumps(value, ensure_ascii=False).encode("utf-8"))


def _link(directory: Path, value: object) -> str | None:
    """Resolve a Markdown link lexically. Only catalog assets can be used as targets."""
    if not isinstance(value, str) or not value or "\x00" in value:
        return None
    try:
        url = urlsplit(value)
    except ValueError:
        return None
    relative = unquote(url.path)
    if url.scheme or url.netloc or not relative or "\x00" in relative or Path(relative).is_absolute():
        return None
    return os.path.abspath(directory / relative)


def _relative_link(parent: Path, path: str) -> str:
    # YAML links are plain strings but still parsed as URLs when read.
    return quote(os.path.relpath(path, parent), safe="/ ()")


def _directory(path: Path, root: Path) -> Path:
    if any(parent.is_symlink() for parent in (path, *path.parents) if parent.is_relative_to(root)):
        raise ValueError("知识库目录不能是符号链接")
    if not path.resolve().is_relative_to(root):
        raise ValueError("知识库目录不在当前范围")
    return path


class Knowledge:
    def __init__(self, home: Path, workspace: Path, *, company_root: Path | None = None, collection_search=None):
        self.home = Path(home).resolve()
        self.root = Path(workspace).resolve()
        self.company_root = Path(company_root).resolve() if company_root is not None else self._infer_company()
        if self.root != self.company_root and self.root.parent != self.company_root / "projects":
            raise ValueError("知识库项目必须属于当前公司")
        self.scope = "company" if self.root == self.company_root else f"project:{self.root.name}"
        self.store = _directory(self.home / "knowledge" / _hash(str(self.root))[:16], self.home)
        self.store.mkdir(parents=True, exist_ok=True)
        self.media = self.store / "media"
        self.cache_file = self.store / "catalog.json"
        self.legacy_notes = self.store / "annotations.json"
        self.lock = FileLock(str(self.store / "catalog.lock"), timeout=60)
        self.space = SpaceCatalog(self.root)
        self._bridge = collection_search

    def _infer_company(self) -> Path:
        return self.root.parent.parent if self.root.parent.name == "projects" else self.root

    def _visible(self, path: Path) -> bool:
        try:
            return _directory(path, self.root).is_file() and not path.is_relative_to(self.home)
        except (OSError, ValueError):
            return False

    def _at(self, root: Path) -> Knowledge:
        if root == self.root:
            return self
        return Knowledge(self.home, root, company_root=self.company_root, collection_search=self._bridge)

    def _company_projects(self) -> list[Path]:
        base = self.company_root / "projects"
        if base.is_symlink() or not base.is_dir():
            return []
        return sorted(path for path in base.iterdir() if not path.is_symlink() and path.is_dir()
                      and not path.name.startswith(".") and path.name == path.name.strip()
                      and len(path.name) <= 120 and not re.search(r"[\\\x00-\x1f\x7f]", path.name))

    def _roots(self, scope: str, include_company: bool = True) -> list[Path]:
        if not isinstance(scope, str) or scope not in QUERY_SCOPES:
            raise ValueError("知识库范围无效")
        if scope == "skills":
            return []
        if scope == "company":
            return [self.company_root]
        if scope == "all":
            return list(dict.fromkeys((self.root, self.company_root, *self._company_projects())))
        return list(dict.fromkeys((self.root, self.company_root))) if include_company else [self.root]

    @asynccontextmanager
    async def _sync(self, collection: str):
        # Serialize projection creation and the whole qmd refresh across MCP and HTTP.
        lock = FileLock(str(self.store / f"{collection}.lock"), timeout=0)
        deadline = time.monotonic() + 120
        while True:
            try:
                lock.acquire()
                break
            except FileLockTimeout:
                if time.monotonic() >= deadline:
                    raise ValueError("知识库正在更新，请稍后重试") from None
                await asyncio.sleep(0.05)
        try:
            yield
        finally:
            lock.release()

    def _safe_media(self, value: str) -> Path | None:
        target = Path(value)
        if target.is_symlink() or not target.is_file() or self.media.is_symlink():
            return None
        resolved = target.resolve()
        return resolved if resolved.is_relative_to(self.media) else None

    @staticmethod
    def _attach(header: dict, file: Path) -> tuple[str | None, bool]:
        media = _link(file.parent, header.get("media"))
        if media and kind_of(Path(media)) in MEDIA_KINDS:
            return media, True
        if re.search(r"\.metadata(?:-\d+)?\.md$", file.name):
            source = _link(file.parent, header.get("source"))
            return source, source is not None
        return None, False

    def _companion(self, asset: dict) -> Path:
        if asset["extracted"]:
            folder = _directory(self.root / "knowledge" / ".extracted-metadata", self.root)
            folder.mkdir(parents=True, exist_ok=True)
            return folder / (_hash(asset["relative"]) + ".md")
        source = Path(asset["path"])
        candidates = [source.with_suffix(".md")] if asset["kind"] in MEDIA_KINDS else []
        candidates.append(source.with_name(source.name + ".metadata.md"))
        for candidate in candidates:
            if candidate.is_symlink():
                continue
            if not candidate.exists():
                return candidate
            if candidate.is_file():
                header, _ = read_markdown(candidate, MAX_FRONTMATTER)
                if self._attach(header, candidate)[0] == asset["path"]:
                    return candidate
        for number in range(1, 10000):
            candidate = source.with_name(f"{source.name}.metadata-{number}.md")
            if not candidate.exists() and not candidate.is_symlink():
                return candidate
        raise ValueError("同名说明文件过多")

    def _save_note(self, asset: dict, metadata: dict, body: str, *, path: Path | None = None, create_only: bool = False) -> Path:
        target = path if path is not None else self._companion(asset)
        if asset["extracted"]:
            metadata.pop("media", None)
            metadata.pop("source", None)
        else:
            key = "media" if asset["kind"] in MEDIA_KINDS else "source"
            metadata[key] = _relative_link(target.parent, asset["path"])
        metadata["scope"] = self.scope
        metadata["kind"] = asset["kind"]
        replace_bytes(target, markdown_bytes(metadata, body), create_only=create_only)
        return target

    def _catalog(self) -> tuple[dict, dict, dict]:
        """Read one physical scope. Caller holds its catalog lock."""
        listing = self.space.files(exclude_top=frozenset({"projects"}) if self.scope == "company" else frozenset())
        previous = _read_json(self.cache_file)
        old = previous.get("sources", {}) if previous.get("version") == PARSE_VERSION else {}
        legacy_notes = _read_json(self.legacy_notes)
        visible = {item["path"]: item for item in listing["items"] if self._visible(Path(item["path"]))}
        headers, notes, attached = {}, {}, set()
        warnings = ["资料超过 2000 项，当前仅检索已收录部分"] if listing["truncated"] else []
        for value in sorted(visible):
            path = Path(value)
            if path.suffix.lower() not in MARKDOWN_SUFFIXES:
                continue
            header, body = read_markdown(path, MAX_NOTE_READ)
            target, companion = self._attach(header, path)
            if companion:
                attached.add(value)
                if target in visible and target != value:
                    current = notes.get(target)
                    # The conventional same-stem companion takes precedence.
                    if current is None or Path(target).with_suffix(".md") == path:
                        notes[target] = (path, header, body)
            else:
                headers[value] = header

        sources, assets = {}, {}
        for value, item in visible.items():
            if value in attached:
                continue
            path = Path(value)
            try:
                info = path.stat()
            except OSError:
                continue
            if not self._visible(path):
                continue
            stamp = [info.st_size, info.st_mtime_ns, info.st_ctime_ns]
            cached = old.get(item["relative"], {})
            if cached.get("stamp") != stamp or any(not self._safe_media(i["path"]) for i in cached.get("images", [])):
                parsed = {"chunks": [], "images": [], "warnings": []}
                if item["kind"] == "document":
                    if path.suffix.lower() in SUPPORTED_TEXT and info.st_size <= MAX_FILE_BYTES:
                        digest = _hash(item["relative"] + str(stamp))[:20]
                        parsed = parse_document(path, item["relative"], _directory(self.media / digest, self.store))
                    else:
                        parsed["warnings"].append("未解析正文，仅收录名称和说明")
                cached = {**parsed, "stamp": stamp}
            sources[item["relative"]] = cached
            warnings.extend(f"{item['relative']}：{warning}" for warning in cached.get("warnings", []))
            assets[value] = {**item, "scope": self.scope, "relations": [], "extracted": False}
            for extracted in cached.get("images", []):
                self._add_extracted(assets, item, extracted)

        for value, asset in assets.items():
            if asset["extracted"]:
                directory = self.root / "knowledge" / ".extracted-metadata"
                path = directory / (_hash(asset["relative"]) + ".md")
                if not directory.is_symlink() and not directory.parent.is_symlink() and path.is_file() and not path.is_symlink():
                    metadata, body = read_markdown(path, MAX_NOTE_READ)
                    notes[value] = (path, metadata, body)
            if value not in notes:
                legacy = legacy_notes.get(asset["relative"], {})
                if isinstance(legacy, dict) and legacy:
                    self._migrate_note(asset, legacy, assets, notes, warnings)
            sidecar, metadata, body = notes.get(value, (Path(value), {}, ""))
            inline = headers.get(value, {})
            aliases = values(metadata.get("aliases", inline.get("aliases")), limit=30, width=200)
            title = metadata.get("title", inline.get("title"))
            description = metadata.get("description", inline.get("description", ""))
            if sidecar != Path(value):
                description = body.strip() if body.strip() else metadata.get("description", "")
            related = values(metadata.get("related", inline.get("related")), limit=30, width=2000)
            asset.update(title=title[:200] if isinstance(title, str) and title.strip() else Path(asset["name"]).stem,
                         alias=aliases[0] if aliases else "", aliases=aliases, sidecar=str(sidecar) if value in notes else None,
                         description=description[:8000] if isinstance(description, str) and description else asset.get("description", ""),
                         related_paths=list(dict.fromkeys(target for ref in related if (target := _link(sidecar.parent, ref))
                                                          and target in assets and target != value)))
            for target in asset["related_paths"]:
                self._relate(assets, value, target, "related_to", "")
            for ref in values(metadata.get("derived_from"), limit=20, width=2000):
                target = _link(sidecar.parent, ref)
                self._relate(assets, value, target, "derived_from", "")

        parser = MarkdownIt()
        for value, asset in assets.items():
            path = Path(value)
            if asset["extracted"] or path.suffix.lower() not in MARKDOWN_SUFFIXES:
                continue
            source = sources.get(asset["relative"], {})
            markdown = "\n".join(chunk["text"] for chunk in source.get("chunks", []))
            for token in parser.parse(markdown):
                for child in token.children or []:
                    if child.type != "image":
                        continue
                    target = _link(path.parent, child.attrGet("src"))
                    if target not in assets or assets[target]["kind"] != "image":
                        continue
                    self._relate(assets, value, target, "references", "文档图片引用")
                    if child.content and not assets[target]["description"]:
                        assets[target]["description"] = child.content
        _write_json(self.cache_file, {"version": PARSE_VERSION, "sources": sources, "indexed_at": previous.get("indexed_at")})
        return {**listing, "items": list(assets.values()), "warnings": warnings[:100],
                "indexed_at": previous.get("indexed_at")}, sources, notes

    def _migrate_note(self, asset: dict, legacy: dict, assets: dict, notes: dict, warnings: list[str]) -> None:
        try:
            sidecar = self._companion(asset)
            metadata = {
                "aliases": values([legacy.get("alias")], limit=1, width=200),
                "related": [_relative_link(sidecar.parent, path) for path in values(legacy.get("related_paths"), limit=30, width=2000)
                            if path in assets],
                "derived_from": [_relative_link(sidecar.parent, path) for path in values(legacy.get("derived_from"), limit=20, width=2000)
                                 if path in assets],
            }
            body = legacy.get("description", "")
            if not isinstance(body, str):
                body = ""
            self._save_note(asset, metadata, body[:8000], path=sidecar, create_only=True)
            notes[asset["path"]] = (sidecar, metadata, body)
        except (OSError, ValueError):
            warnings.append(f"{asset['relative']}：旧说明未能迁移到 Markdown")

    def _add_extracted(self, assets: dict, source: dict, image: dict) -> None:
        path = self._safe_media(image["path"])
        if path is None:
            return
        value = str(path)
        if value not in assets:
            try:
                size = path.stat().st_size
            except OSError:
                return
            assets[value] = {"path": value, "relative": f"{source['relative']}#{path.name}", "name": image["name"],
                             "kind": "image", "scope": self.scope, "section": source["section"], "size": size,
                             "modified": source["modified"], "description": image.get("description", ""),
                             "relations": [], "extracted": True}
        self._relate(assets, value, source["path"], "extracted_from", image["locator"])

    @staticmethod
    def _relate(assets: dict, source: str, target: str | None, relation: str, locator: str) -> None:
        if source == target or source not in assets or target not in assets:
            return
        reverse = {"references": "referenced_by", "derived_from": "source_of", "extracted_from": "contains"}.get(relation, "related_to")
        for left, right, kind in [(source, target, relation), (target, source, reverse)]:
            value = {"path": right, "name": assets[right]["name"], "relation": kind, "locator": locator}
            if value not in assets[left]["relations"]:
                assets[left]["relations"].append(value)

    def catalog(self, scope: str = "project") -> dict:
        if scope == "skills":
            return self._skill_catalog()
        if not isinstance(scope, str) or scope not in {"project", "company"}:
            raise ValueError("知识库范围无效")
        target = self if scope == "project" else self._at(self.company_root)
        with target.lock:
            return target._catalog()[0]

    def _owner(self, value: str) -> Knowledge:
        if not isinstance(value, str) or not value or "\x00" in value:
            raise ValueError("资料路径无效")
        path = Path(os.path.abspath(Path(value).expanduser()))
        if (path.is_relative_to(self.root) or path.is_relative_to(self.media)) and (
            self.scope != "company" or not path.is_relative_to(self.company_root / "projects")
        ):
            return self
        company = self._at(self.company_root)
        if path.is_relative_to(company.media):
            return company
        if path.is_relative_to(self.company_root) and not path.is_relative_to(self.company_root / "projects"):
            return company
        raise ValueError("文件不属于当前知识库或已被删除")

    def resolve(self, path: str) -> Path:
        owner = self._owner(path)
        target = Path(os.path.abspath(Path(path).expanduser()))
        if target.is_relative_to(owner.root):
            try:
                _directory(target, owner.root)
                if owner.scope == "company" and target.is_relative_to(owner.root / "projects"):
                    raise ValueError
                return owner.space.resolve(str(target))
            except (OSError, ValueError):
                pass
        safe = owner._safe_media(str(target))
        if safe and any(item["path"] == str(safe) for item in owner.catalog()["items"]):
            return safe
        raise ValueError("文件不属于当前知识库或已被删除")

    def annotate(self, path: str, alias: str | None = None, description: str | None = None,
                 related_paths: list[str] | None = None, *, aliases: list[str] | None = None) -> dict:
        if alias is not None and (not isinstance(alias, str) or len(alias) > 200):
            raise ValueError("别名最多 200 字")
        if aliases is not None and (not isinstance(aliases, list) or len(aliases) > 30
                                    or any(not isinstance(value, str) or len(value) > 200 for value in aliases)):
            raise ValueError("别名最多 30 个，每个最多 200 字")
        if description is not None and (not isinstance(description, str) or len(description) > 8000):
            raise ValueError("说明最多 8000 字")
        if related_paths is not None and (not isinstance(related_paths, list) or len(related_paths) > 30
                                          or any(not isinstance(value, str) for value in related_paths)):
            raise ValueError("关联资料最多 30 个")
        owner = self._owner(path)
        with owner.lock:
            catalog, _, notes = owner._catalog()
            assets = {item["path"]: item for item in catalog["items"]}
            if path not in assets or any(value not in assets or value == path for value in related_paths or []):
                raise ValueError("所选资料不属于当前知识库")
            item = assets[path]
            sidecar, metadata, _ = notes[path] if path in notes else (owner._companion(item), {}, "")
            new_aliases = aliases if aliases is not None else ([alias] if alias is not None else item["aliases"])
            related = item["related_paths"] if related_paths is None else related_paths
            metadata = {**metadata, "title": item["title"], "aliases": values(new_aliases, limit=30, width=200),
                        "related": [_relative_link(sidecar.parent, value) for value in dict.fromkeys(related)]}
            metadata.pop("description", None)
            body = item["description"] if description is None else description.strip()
            owner._save_note(item, metadata, body, path=sidecar)
            return next(asset for asset in owner._catalog()[0]["items"] if asset["path"] == path)

    def record_generation(self, paths: list[str], prompt: str, references: list[str]) -> None:
        """Record the generation request and only sources inside the same scope."""
        with self.lock:
            catalog, _, notes = self._catalog()
            assets = {item["path"]: item for item in catalog["items"]}
            for path in paths:
                if path not in assets:
                    raise ValueError("生成文件不属于当前知识库")
                asset = assets[path]
                sidecar, metadata, _ = notes[path] if path in notes else (self._companion(asset), {}, "")
                metadata = {**metadata, "title": asset["title"], "aliases": asset["aliases"],
                            "derived_from": [_relative_link(sidecar.parent, ref) for ref in dict.fromkeys(references)
                                             if ref in assets and ref != path][:20]}
                self._save_note(asset, metadata, f"生成要求：{prompt}"[:8000], path=sidecar)

    @staticmethod
    def validate_import(name: str, data: bytes) -> str:
        if not isinstance(name, str) or any(ord(character) < 32 or ord(character) == 127 for character in name):
            raise ValueError("文件名无效")
        filename = Path(name.replace("\\", "/")).name
        if not filename or filename.startswith(".") or Path(filename).suffix.lower() not in IMPORT_SUFFIXES:
            raise ValueError("不支持此文件类型")
        if len(data) > MAX_FILE_BYTES:
            raise ValueError("每个文件不能超过 32 MB")
        return filename

    def import_files(self, files: list[tuple[str, bytes]], *, scope: str = "project") -> list[Path]:
        if not isinstance(scope, str) or scope not in {"project", "company"}:
            raise ValueError("请选择项目或公司作为归属")
        if not 1 <= len(files) <= 20 or sum(len(data) for _, data in files) > 128 * 1024 * 1024:
            raise ValueError("一次最多导入 20 个文件，合计不超过 128 MB")
        validated = [(self.validate_import(name, data), data) for name, data in files]
        owner = self if scope == "project" else self._at(self.company_root)
        created = []
        with owner.lock:
            try:
                paths = [owner._import_file(name, data, created) for name, data in validated]
                for path in paths:
                    owner._import_note(path, created)
            except (OSError, ValueError):
                for path in reversed(created):
                    path.unlink(missing_ok=True)
                raise ValueError("导入失败，本批文件未保留，请重试") from None
        return paths

    def import_file(self, name: str, data: bytes) -> Path:
        return self.import_files([(name, data)])[0]

    def _import_file(self, filename: str, data: bytes, created: list[Path]) -> Path:
        folder = _directory(self.root / "knowledge" / "imports", self.root)
        folder.mkdir(parents=True, exist_ok=True)
        stem, suffix = Path(filename).stem, Path(filename).suffix
        for number in range(10000):
            path = folder / (filename if number == 0 else f"{stem} ({number}){suffix}")
            try:
                stream = path.open("xb")
            except FileExistsError:
                continue
            created.append(path)
            with stream:
                stream.write(data)
            return path
        raise ValueError("同名文件过多")

    def _import_note(self, path: Path, created: list[Path], *, metadata: dict | None = None, body: str = "") -> None:
        note = {"title": path.stem, **(metadata or {})}
        if path.suffix.lower() in MARKDOWN_SUFFIXES:
            inline, description = read_markdown(path, MAX_NOTE_READ)
            attachment, companion = self._attach(inline, path)
            if metadata is None and companion and attachment and self._visible(Path(attachment)):
                asset = {"path": attachment, "kind": kind_of(Path(attachment)), "extracted": False}
                self._save_note(asset, inline, description, path=path)
                return
            if metadata is None:
                note = {key: inline[key] for key in ("title", "aliases", "related", "description") if key in inline}
        asset = {"path": str(path), "kind": kind_of(path), "extracted": False}
        sidecar = self._companion(asset)
        if sidecar.exists():
            return
        self._save_note(asset, note, body, path=sidecar, create_only=True)
        created.append(sidecar)

    def promote(self, path: str) -> dict:
        """Copy a project item to company knowledge, including portable annotations."""
        if self.scope == "company" or self._owner(path) is not self:
            raise ValueError("只能提升当前项目的资料")
        with self.lock:
            item = next((asset for asset in self._catalog()[0]["items"] if asset["path"] == path), None)
            if item is None:
                raise ValueError("资料已被删除")
            source = self.resolve(path)
            with source.open("rb") as stream:
                data = stream.read(MAX_FILE_BYTES + 1)
            filename = self.validate_import(source.name, data)
        company = self._at(self.company_root)
        created = []
        with company.lock:
            try:
                new_path = company._import_file(filename, data, created)
                company._import_note(new_path, created, metadata={"title": item["title"], "aliases": item["aliases"], "related": []},
                                     body=item["description"])
            except (OSError, ValueError):
                for target in reversed(created):
                    target.unlink(missing_ok=True)
                raise ValueError("提升资料失败，请重试") from None
            return next(asset for asset in company._catalog()[0]["items"] if asset["path"] == str(new_path))

    @property
    def bridge(self):
        if self._bridge is None:
            from aiopc.collection_search import CollectionSearch

            self._bridge = CollectionSearch(self.home)
        return self._bridge

    def _view(self, collection: str, roots: list[Path], anchor: Knowledge) -> tuple[Path, dict, dict, list[str]]:
        view = _directory(anchor.store / collection, anchor.store)
        view.mkdir(mode=0o700, parents=True, exist_ok=True)
        assets, records, warnings = {}, {}, []
        for root in roots:
            owner = self._at(root)
            with owner.lock:
                catalog, sources, _ = owner._catalog()
                for item in catalog["items"]:
                    if item["kind"] not in MEDIA_KINDS or item["extracted"] or item["sidecar"]:
                        continue
                    try:
                        sidecar = owner._save_note(item, {"title": item["title"], "aliases": []}, "", create_only=True)
                        item["sidecar"] = str(sidecar)
                    except (OSError, ValueError):
                        warnings.append(f"{item['relative']}：无法创建媒体说明文件")
            warnings.extend(catalog["warnings"])
            for item in catalog["items"]:
                assets[item["path"]] = item
                chunks = sources.get(item["relative"], {}).get("chunks", []) if not item["extracted"] else []
                label = item["description"]
                if not chunks or label or item["aliases"]:
                    chunks = [{"text": label, "locator": "资料说明"}, *chunks]
                for number, chunk in enumerate(chunks):
                    name = _hash(f"{item['scope']}\0{item['relative']}\0{number}") + ".md"
                    metadata = {"title": item["title"], "aliases": item["aliases"], "scope": item["scope"], "kind": item["kind"],
                                "source_path": item["path"], "locator": chunk["locator"]}
                    title = " ".join(item["title"].splitlines())
                    body = f"# {title}\n\n{chunk['text']}"
                    replace_bytes(view / name, markdown_bytes(metadata, body))
                    records[name] = metadata
        for file in view.glob("*.md"):
            if file.name not in records:
                file.unlink(missing_ok=True)
        return view, assets, records, warnings

    async def _snapshot(self, collection: str, roots: list[Path], anchor: Knowledge) -> tuple[Path, dict, dict, list[str]]:
        snapshot = asyncio.create_task(asyncio.to_thread(self._view, collection, roots, anchor))
        try:
            return await asyncio.shield(snapshot)
        except asyncio.CancelledError:
            await snapshot
            raise

    def _projection(self, scope: str, include_company: bool = True):
        roots = self._roots(scope, include_company)
        if scope in {"all", "company"} or roots == [self.company_root]:
            anchor = self._at(self.company_root)
        else:
            anchor = self
        variant = scope if scope == "all" else ("company" if roots == [self.company_root] else
                                                 "project-with-company" if len(roots) > 1 else "project")
        collection = "knowledge-" + _hash(f"{anchor.root}\0{variant}")[:24]
        scopes = tuple(self._at(root).scope for root in roots)
        return collection, anchor, roots, scopes

    async def reindex(self, scope: str = "project", *, include_company: bool = True) -> dict:
        if scope == "skills":
            if not self._register_skills():
                return {"files": 0, "chunks": 0, "warnings": [], "mode": "empty"}
            summary = await self.bridge.refresh("skills", scopes=("skills",))
            files = sum(1 for path in self._skill_root().glob("**/*.md") if path.is_file() and not path.is_symlink())
            return {"files": files, "chunks": files, "warnings": [], "mode": "fts", **summary}
        collection, anchor, roots, scopes = self._projection(scope, include_company)
        async with anchor._sync(collection):
            view, assets, records, warnings = await self._snapshot(collection, roots, anchor)
            self.bridge.register(collection, view)
            summary = await self.bridge.refresh(collection, scopes=scopes)
            indexed_at = time.time()
            for root in roots:
                owner = self._at(root)
                with owner.lock:
                    cache = _read_json(owner.cache_file)
                    cache["indexed_at"] = indexed_at
                    _write_json(owner.cache_file, cache)
        return {"mode": "fts", **summary, "files": len(assets), "chunks": len(records), "warnings": warnings + summary.get("warnings", [])}

    def _skill_root(self) -> Path:
        return self.home / "library" / "skills-index"

    def _register_skills(self) -> bool:
        root = self._skill_root()
        if not root.is_dir() or root.is_symlink() or root.parent.is_symlink():
            return False
        self.bridge.register("skills", root)
        return True

    def _skill_asset(self, path: Path, metadata: dict) -> dict | None:
        root = self._skill_root()
        if not path.is_relative_to(root) or ".." in path.relative_to(root).parts:
            return None
        try:
            if not _directory(path, root).is_file():
                return None
            info = path.stat()
        except (OSError, ValueError):
            return None
        relative = path.relative_to(root).as_posix()
        title = metadata.get("title") or metadata.get("name")
        if not isinstance(title, str) or not title.strip():
            title = path.stem
        description = metadata.get("description")
        aliases = values(metadata.get("aliases"), limit=30, width=200)
        return {"path": str(path), "relative": relative, "title": title[:200], "name": title[:200], "kind": "skill",
                "scope": "skills", "section": "knowledge", "size": info.st_size, "modified": info.st_mtime,
                "alias": aliases[0] if aliases else "", "aliases": aliases, "description": description[:800] if isinstance(description, str) else "",
                "related_paths": [], "relations": [], "extracted": False}

    def _skill_catalog(self) -> dict:
        items = []
        truncated = False
        root = self._skill_root()
        if root.is_dir() and not root.is_symlink() and not root.parent.is_symlink():
            for directory, folders, files in os.walk(root, followlinks=False):
                folders[:] = sorted(folder for folder in folders if not folder.startswith("."))
                for name in sorted(files):
                    path = Path(directory) / name
                    if name.startswith(".") or path.suffix.lower() not in MARKDOWN_SUFFIXES or path.is_symlink():
                        continue
                    metadata, _ = read_markdown(path, MAX_FRONTMATTER)
                    if metadata.get("scope") != "skills":
                        continue
                    if asset := self._skill_asset(path, metadata):
                        items.append(asset)
                    if len(items) > 2000:
                        truncated = True
                        break
                if truncated:
                    break
        return {"items": items[:2000], "truncated": truncated, "warnings": [], "indexed_at": None}

    async def _skill_hits(self, query: str, kind: str | None, limit: int) -> list[dict]:
        if kind not in {None, "skill"} or not self._register_skills():
            return []
        root = self._skill_root()
        hits = await self.bridge.search("skills", query, scopes=("skills",), kind=kind, limit=limit)
        results = []
        for hit in hits:
            raw, metadata = hit.get("source_path"), hit.get("frontmatter")
            if not isinstance(raw, str) or not isinstance(metadata, dict) or hit.get("scope") != "skills":
                continue
            if asset := self._skill_asset(root / raw, metadata):
                results.append({"asset": asset, "source_path": asset["path"], "title": asset["title"], "scope": "skills",
                                "frontmatter": metadata, "snippet": hit.get("snippet", ""),
                                "locator": "技能索引", "score": hit.get("score", 0), "related": []})
        return results

    async def search(self, query: str, limit: int = 8, *, scope: str = "project", kind: str | None = None,
                     include_company: bool = True) -> dict:
        if not isinstance(query, str) or not query.strip() or len(query) > 2000:
            raise ValueError("请输入 1–2000 字的查询内容")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 30:
            raise ValueError("结果数量取 1–30")
        if kind is not None and (not isinstance(kind, str) or kind not in {*KINDS, "skill"}):
            raise ValueError("资料类型无效")
        query = query.strip()
        collection, anchor, roots, scopes = self._projection(scope, include_company)
        results, warnings = [], []
        mode = "fts"
        if roots and kind != "skill":
            async with anchor._sync(collection):
                view, assets, records, warnings = await self._snapshot(collection, roots, anchor)
                self.bridge.register(collection, view)
                hits = await self.bridge.search(collection, query, scopes=scopes, kind=kind, limit=min(limit * 4, 100)) if records else []
                mode = hits[0].get("mode", "fts") if hits else "fts"
                warnings.extend(warning for hit in hits for warning in hit.get("warnings", []) if isinstance(warning, str))
                results = self._knowledge_hits(view, assets, records, hits, kind, scopes, limit)
        if scope in {"skills", "all"}:
            skills = await self._skill_hits(query, kind, limit)
            results = [item for pair in zip_longest(results, skills) for item in pair if item is not None]
        return {"query": query, "scope": scope, "kind": kind, "items": results[:limit],
                "mode": mode, "warnings": list(dict.fromkeys(warnings))}

    @staticmethod
    def _knowledge_hits(view: Path, assets: dict, records: dict, hits: list[dict], kind: str | None, scopes: tuple[str, ...],
                        limit: int) -> list[dict]:
        results, seen = [], set()
        for hit in hits:
            value = hit.get("source_path")
            if not isinstance(value, str):
                continue
            path = Path(value)
            if path.is_absolute():
                if path.parent != view:
                    continue
                path = path.relative_to(view)
            metadata = records.get(str(path))
            if not metadata or metadata["scope"] not in scopes or metadata["scope"] != hit.get("scope"):
                continue
            asset = assets[metadata["source_path"]]
            if asset["path"] in seen or (kind is not None and asset["kind"] != kind) or not Path(asset["path"]).is_file():
                continue
            seen.add(asset["path"])
            related = [assets[value["path"]] for value in asset["relations"] if value["path"] in assets]
            results.append({"asset": asset, "source_path": asset["path"], "title": asset["title"], "scope": asset["scope"],
                            "frontmatter": metadata, "snippet": str(hit.get("snippet") or "")[:2400], "locator": metadata["locator"],
                            "score": hit.get("score", 0), "related": related[:12]})
            if len(results) == limit:
                break
        return results
