import json
import os
import subprocess
from pathlib import Path

import pytest

from aiopc.skillhub import upstream
from aiopc.skillhub.catalog import load_catalog
from aiopc.skillhub.upstream import GitRepository, UpstreamError, is_script


def git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", "-C", str(root), *args],
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip()


@pytest.fixture
def repository(tmp_path):
    root = tmp_path / "upstream"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "config", "user.name", "Fixture")
    git(root, "config", "user.email", "fixture@example.com")
    return root


def write(root: Path, path: str, data: str) -> Path:
    file = root / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(data, encoding="utf-8")
    return file


def commit(root: Path) -> str:
    git(root, "add", ".")
    git(root, "commit", "-m", "fixture")
    return git(root, "rev-parse", "HEAD")


def test_catalog_preserves_bilingual_metadata_and_unmirrored_rows(tmp_path):
    base = "https://github.com/Author/Repo"
    direct = {
        "url": f"{base}/blob/HEAD/one%20skill/SKILL.md",
        "entries": {
            "zh": [{"name": "网页复刻", "description": "根据参考复刻页面"}],
            "en": [{"name": "Page Clone"}, {"name": "Page Clone", "description": "Recreate a reference site"}],
        },
        "sources": {"en": ["docs/en/full-design.md"], "zh": ["docs/zh/full-design.md", "docs/zh/platforms/p-x.md"]},
    }
    rows = [
        direct,
        {"url": base},
        {"url": f"{base.lower()}/tree/{'a' * 40}/two"},
        {"url": f"{base}/blob/HEAD/README.md"},
        {"url": "https://example.com/skill"},
        {"url": f"{base}/blob/HEAD/%2e%2e/SKILL.md"},
    ]
    file = write(tmp_path, "catalog.json", json.dumps({"schema_version": 2, "resources": rows}))
    skills = load_catalog(file)
    assert [item.kind for item in skills] == ["skill", "repository", "tree", "reference", "external", "reference"]
    assert [item.repository for item in skills] == ["author/repo", "author/repo", "author/repo", "author/repo", None, "author/repo"]
    assert (skills[0].ref, skills[0].path) == ("HEAD", "one skill/SKILL.md")
    assert skills[0].names == {"en": ("Page Clone",), "zh": ("网页复刻",)}
    assert skills[0].descriptions == {"en": ("Recreate a reference site",), "zh": ("根据参考复刻页面",)}
    assert skills[0].categories == ("full-design", "platforms/p-x")
    assert (skills[2].ref, skills[2].path) == ("a" * 40, "two")


def test_copy_from_pinned_git_tree_and_exclude_nested_skill(repository, tmp_path):
    write(repository, "LICENSE", "SPDX-License-Identifier: MIT\n")
    write(repository, "pack/one/SKILL.md", "original")
    binary = bytes(range(256)) * 20
    write(repository, "pack/one/assets/image.bin", "").write_bytes(binary)
    runner = write(repository, "pack/one/custom", "fixture data")
    runner.chmod(0o755)
    write(repository, "pack/one/nested/SKILL.md", "nested")
    write(repository, "pack/one/nested/other.txt", "nested asset")
    write(repository, "other/SKILL.md", "other")
    pinned = commit(repository)
    write(repository, "pack/one/SKILL.md", "changed")
    latest = commit(repository)
    write(repository, "pack/one/SKILL.md", "working copy")

    checkout = GitRepository(repository)
    snapshot = checkout.snapshot(pinned)
    assert snapshot.commit == pinned
    assert checkout.snapshot("HEAD").commit == latest
    assert snapshot.skill_paths("pack") == ("pack/one/SKILL.md", "pack/one/nested/SKILL.md")
    assert snapshot.skill_paths("pa") == ()
    assert snapshot.license_for("pack/one/SKILL.md") == "MIT"
    destination = tmp_path / "artifact"
    assert snapshot.copy_skill("pack/one/SKILL.md", destination) is True
    assert (destination / "SKILL.md").read_text() == "original"
    assert (destination / "assets" / "image.bin").read_bytes() == binary
    assert os.stat(destination / "custom").st_mode & 0o111 == 0
    assert not (destination / "nested").exists()


def test_single_shallow_clone_resolves_default_branch_and_other_pinned_refs(repository, tmp_path, monkeypatch):
    write(repository, "skill/SKILL.md", "first")
    first = commit(repository)
    git(repository, "switch", "-c", "feature")
    write(repository, "skill/SKILL.md", "feature")
    feature = commit(repository)
    git(repository, "switch", "main")
    write(repository, "skill/SKILL.md", "latest")
    latest = commit(repository)

    command = upstream._git

    def local_git(*args: str, **kwargs):
        return command(*(repository.as_uri() if arg == "https://github.com/example/repo.git" else arg for arg in args), **kwargs)

    monkeypatch.setattr(upstream, "_git", local_git)
    monkeypatch.setitem(upstream._GIT_ENV, "GIT_ALLOW_PROTOCOL", "file")
    clone = tmp_path / "clone"
    upstream_repo = GitRepository.clone("example/repo", clone)

    assert [item.name for item in clone.iterdir()] == [".git"]
    assert git(clone, "rev-parse", "--is-shallow-repository") == "true"
    assert upstream_repo.snapshot("main") is upstream_repo.snapshot("HEAD")
    assert upstream_repo.snapshot("HEAD").commit == latest
    assert upstream_repo.snapshot("feature").commit == feature
    pinned = upstream_repo.snapshot(first)
    assert pinned.commit == first
    assert pinned.copy_skill("skill/SKILL.md", tmp_path / "first") is False
    assert (tmp_path / "first" / "SKILL.md").read_text() == "first"


def test_refuse_links_missing_skills_and_existing_destination(repository, tmp_path):
    write(repository, "safe/SKILL.md", "safe")
    write(repository, "linked/SKILL.md", "link reference")
    (repository / "linked" / "notes.txt").symlink_to("../safe/SKILL.md")
    commit(repository)
    snapshot = GitRepository(repository).snapshot("HEAD")
    destination = tmp_path / "artifact"
    with pytest.raises(UpstreamError, match="link") as unsafe:
        snapshot.copy_skill("linked/SKILL.md", destination)
    assert unsafe.value.reason == "unsafe"
    assert not destination.exists()
    with pytest.raises(UpstreamError) as missing:
        snapshot.copy_skill("safe/../safe/SKILL.md", destination)
    assert missing.value.reason == "missing"
    destination.mkdir()
    sentinel = write(destination, "keep", "local")
    with pytest.raises(UpstreamError):
        snapshot.copy_skill("safe/SKILL.md", destination)
    assert sentinel.read_text() == "local"


@pytest.mark.parametrize(
    ("path", "header", "executable", "expected"),
    [
        ("scripts/data.txt", b"data", False, True),
        ("tools/runner.PY", b"", False, True),
        ("custom", b"", True, True),
        ("custom", b"#!/bin/sh", False, True),
        ("custom", b"\x7fELF", False, True),
        ("assets/picture.png", b"\x89PNG", False, False),
        ("references/checklist.md", b"# Checklist", False, False),
    ],
)
def test_script_classifier(path, header, executable, expected):
    assert is_script(path, header, executable=executable) is expected
