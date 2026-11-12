from pathlib import Path

import pytest

from aiopc.skillhub import mirror
from aiopc.skillhub.audit import AuditResult
from aiopc.skillhub.catalog import CatalogEntry
from aiopc.skillhub.manifest import read_manifest, read_skills, skill_content, write_manifest
from aiopc.skillhub.upstream import UpstreamError


def test_mirror_deduplicates_expands_pins_and_records_catalog_coverage(tmp_path, monkeypatch):
    library, scratch = tmp_path / "library", tmp_path / "scratch"
    scratch.mkdir()
    base = "https://github.com/owner/repo"
    entries = [
        CatalogEntry(url=base, repository="owner/repo", ref="HEAD", path=None, kind="repository",
                     names={"en": ("Repo",)}, descriptions={}, categories=("marketing",)),
        CatalogEntry(url=base + "/blob/main/one/SKILL.md", repository="owner/repo", ref="main",
                     path="one/SKILL.md", kind="skill", names={"zh": ("复刻营销页",)},
                     descriptions={"zh": ("重建营销页",)}, categories=("design",)),
        CatalogEntry(url=base + "/blob/main/gone/SKILL.md", repository="owner/repo", ref="main",
                     path="gone/SKILL.md", kind="skill", names={}, descriptions={}, categories=()),
        CatalogEntry(url="https://example.com/manual", repository=None, ref=None, path=None, kind="external",
                     names={}, descriptions={}, categories=()),
    ]
    monkeypatch.setattr(mirror, "load_catalog", lambda _: entries)
    clones, refs, scans = [], [], []

    class FakeRepo:
        @staticmethod
        def clone(repo, destination):
            clones.append(repo)
            assert not destination.exists()
            return FakeRepo()

        def snapshot(self, ref):
            refs.append(ref)
            return Snapshot()

    class Snapshot:
        commit = "a" * 40

        def skill_paths(self, prefix=None):
            return ("one/SKILL.md", "two/SKILL.md")

        def license_for(self, path):
            return "MIT"

        def copy_skill(self, path, destination):
            destination.mkdir()
            name = Path(path).parent.name
            (destination / "SKILL.md").write_text(f"---\nname: {name}\ndescription: An example\n---\nBody\n")
            return name == "two"

    class FakeScanner:
        def scan_many(self, directories):
            scans.extend(directories)
            return {path: AuditResult("passed", ()) for path in directories}

    monkeypatch.setattr(mirror, "GitRepository", FakeRepo)
    report = mirror.build_mirror(tmp_path / "catalog.json", library, scratch, FakeScanner(), jobs=2)
    assert clones == ["owner/repo"]
    assert refs == ["HEAD", "main"]
    assert len(scans) == 2
    assert report["catalog"] == {"mirrored": 2, "missing": 1, "manual": 1}
    records = read_skills(library)
    one = next(item for item in records.values() if item.title == "one")
    assert one.names == {"zh": ("复刻营销页",)}
    assert one.categories == ("design", "marketing")
    assert (skill_content(library, one) / "SKILL.md").is_file()
    assert "重建营销页" in (library / "skills-index" / f"{one.id}.md").read_text()

    refs.clear()
    mirror.build_mirror(tmp_path / "catalog.json", library, scratch, FakeScanner(), jobs=2)
    assert refs == ["a" * 40]

    class OfflineRepo:
        @staticmethod
        def clone(*_):
            raise UpstreamError("unreachable", "offline")

    monkeypatch.setattr(mirror, "GitRepository", OfflineRepo)
    report = mirror.build_mirror(tmp_path / "catalog.json", library, scratch, FakeScanner(), jobs=2)
    assert report["catalog"] == {"manual": 1, "unreachable": 3}
    assert read_skills(library) == records
    saved = read_manifest(library)
    assert saved["catalog"][base]["using_previous_snapshot"] is True
    assert saved["catalog"][base]["detail"] == "offline"
    assert (library / "skills-index" / f"{one.id}.md").is_file()


def test_rejects_sample_over_full_library(tmp_path, monkeypatch):
    library, scratch = tmp_path / "library", tmp_path / "scratch"
    library.mkdir()
    scratch.mkdir()
    base = "https://github.com/owner/repo"
    entry = CatalogEntry(base, "owner/repo", "HEAD", None, "repository", {}, {}, ())
    manual = CatalogEntry("https://example.org/manual", None, None, None, "external", {}, {}, ())
    monkeypatch.setattr(mirror, "load_catalog", lambda _: [entry, manual])
    write_manifest(library, {}, {}, {base: {"status": "unreachable"}, manual.url: {"status": "manual"}})

    class OfflineRepo:
        @staticmethod
        def clone(*_):
            raise UpstreamError("unreachable", "offline")

    monkeypatch.setattr(mirror, "GitRepository", OfflineRepo)
    with pytest.raises(ValueError, match="样本"):
        mirror.build_mirror(tmp_path / "catalog.json", library, scratch, None, repositories={"owner/repo"})

    report = mirror.build_mirror(tmp_path / "catalog.json", library, scratch, None)
    assert report["catalog"] == {"manual": 1, "unreachable": 1}
    assert read_manifest(library)["catalog"][base]["detail"] == "offline"
