"""Markdown metadata for knowledge sources and companion files."""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path

import yaml

MARKDOWN_SUFFIXES = {".md", ".markdown"}
MEDIA_KINDS = {"image", "video", "audio"}
MAX_FRONTMATTER = 65_536
MAX_NOTE_READ = MAX_FRONTMATTER + 32_768
_FRONTMATTER = re.compile(r"\A\ufeff?---[ \t]*\r?\n(.*?)^---[ \t]*(?:\r?\n|$)", re.DOTALL | re.MULTILINE)


def split_markdown(text: str) -> tuple[dict, str, int]:
    """Return frontmatter, remaining Markdown and number of header lines."""
    match = _FRONTMATTER.match(text[:MAX_FRONTMATTER])
    if not match:
        return {}, text, 0
    try:
        header = match.group(1)
        if any(isinstance(token, yaml.tokens.AliasToken) for token in yaml.scan(header)):
            return {}, text, 0
        value = yaml.safe_load(header)
    except (yaml.YAMLError, ValueError, RecursionError):
        return {}, text, 0
    if not isinstance(value, dict):
        return {}, text, 0
    return value, text[match.end():], text[:match.end()].count("\n")


def read_markdown(path: Path, limit: int) -> tuple[dict, str]:
    try:
        if path.is_symlink():
            return {}, ""
        with path.open("rb") as stream:
            text = stream.read(limit).decode("utf-8-sig", errors="replace")
    except OSError:
        return {}, ""
    header, body, _ = split_markdown(text)
    return header, body


def markdown_bytes(metadata: dict, body: str = "") -> bytes:
    header = yaml.safe_dump(metadata, sort_keys=False, allow_unicode=True, width=120)
    return f"---\n{header}---\n{body.rstrip()}\n".encode()


def replace_bytes(path: Path, data: bytes, *, create_only: bool = False) -> None:
    if path.is_symlink():
        raise ValueError("知识库文件不能是符号链接")
    if not create_only:
        try:
            if path.read_bytes() == data:
                return
        except FileNotFoundError:
            pass
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".knowledge-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
        if create_only:
            os.link(temporary, path)
        else:
            os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def values(value, *, limit: int, width: int) -> list[str]:
    if not isinstance(value, list):
        return []
    strings = (item.strip()[:width] for item in value[:limit] if isinstance(item, str) and item.strip())
    return list(dict.fromkeys(strings))
