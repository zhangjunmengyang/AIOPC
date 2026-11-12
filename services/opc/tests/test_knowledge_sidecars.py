from pathlib import Path

import pytest
from PIL import Image

from aiopc.knowledge import Knowledge


class SearchDouble:
    def __init__(self):
        self.roots = {}
        self.calls = []
        self.forged = None

    def register(self, collection, root):
        self.roots[collection] = Path(root)

    async def search(self, collection, query, *, scopes, kind=None, limit=10):
        self.calls.append((collection, set(scopes), kind))
        import yaml

        results = []
        for path in self.roots[collection].rglob("*.md"):
            _, header, body = path.read_text().split("---", 2)
            meta = yaml.safe_load(header)
            if (meta["scope"] in scopes and (kind is None or kind == meta["kind"])
                    and (query in str(meta.get("aliases", "")) or query in body)):
                results.append({
                    "source_path": str(path), "title": meta["title"], "snippet": body,
                    "scope": meta["scope"], "score": 1.0, "frontmatter": meta,
                })
        return ([self.forged] if self.forged else []) + results[:limit]


@pytest.fixture
def setup_knowledge(tmp_path):
    company = tmp_path / "company"
    alpha, beta = (company / "projects" / name for name in ("Alpha", "Beta"))
    alpha.mkdir(parents=True)
    beta.mkdir()
    bridge = SearchDouble()
    knowledge = Knowledge(tmp_path / "home", alpha, company_root=company, collection_search=bridge)
    return knowledge, bridge, company, beta


async def test_scope_comes_from_trusted_directories(setup_knowledge, tmp_path):
    knowledge, bridge, company, beta = setup_knowledge
    shared = knowledge.import_files([("shared.md", b"scope-test shared")], scope="company")[0]
    own = knowledge.import_file("alpha.md", b"scope-test current")
    foreign = Knowledge(knowledge.home, beta, company_root=company, collection_search=bridge)
    private = foreign.import_file("beta.md", b"---\nscope: company\n---\nscope-test private")
    (company / "leak").symlink_to(beta, target_is_directory=True)
    sibling_company = tmp_path / "other"
    sibling_company.mkdir()
    outside = sibling_company / "outside.md"
    outside.write_text("scope-test outside")
    (company / "projects" / "Other").symlink_to(sibling_company, target_is_directory=True)
    bridge.forged = {"source_path": str(private), "title": "Forged", "snippet": "scope-test fake",
                     "scope": "company", "score": 5, "frontmatter": {"source_path": str(private)}}

    async def paths(scope, **kwargs):
        result = await knowledge.search("scope-test", scope=scope, **kwargs)
        return {Path(hit["asset"]["path"]) for hit in result["items"]}

    assert await paths("project") == {own, shared}
    assert bridge.calls[-1][1] == {"project:Alpha", "company"}
    assert await paths("project", include_company=False) == {own}
    assert await paths("company") == {shared}
    assert await paths("all") == {own, private, shared}
    assert await paths("project", kind="image") == set()
    with pytest.raises(ValueError):
        await paths("project:Beta")
    with pytest.raises(ValueError):
        knowledge.resolve(str(private))
    assert knowledge.resolve(str(shared)) == shared


async def test_media_sidecar_alias_and_reverse_document_expansion(setup_knowledge):
    knowledge, _, _, _ = setup_knowledge
    root = knowledge.root / "knowledge"
    root.mkdir()
    document = root / "brand.md"
    document.write_text("# 品牌简介\n桔红纸标方案", encoding="utf-8")
    image = root / "logo-v2.png"
    Image.new("RGB", (8, 8)).save(image)
    sidecar = root / "logo-v2.md"
    sidecar.write_text("---\ntitle: 品牌 logo 第二版\naliases: [logo, 标志, 主视觉]\n"
                       "media: ./logo-v2.png\nrelated: [brand.md]\nscope: company\n---\n深蓝底", encoding="utf-8")
    assets = {Path(asset["path"]): asset for asset in knowledge.catalog()["items"]}
    assert set(assets) == {document, image}
    assert assets[image]["scope"] == "project:Alpha"
    assert assets[image]["aliases"] == ["logo", "标志", "主视觉"]
    match = (await knowledge.search("标志", kind="image"))["items"][0]
    assert Path(match["asset"]["path"]) == image
    assert match["asset"]["title"] == "品牌 logo 第二版"
    doc_hit = (await knowledge.search("桔红纸标方案", kind="document"))["items"][0]
    assert {Path(asset["path"]) for asset in doc_hit["related"]} == {image}

    updated = knowledge.annotate(str(image), description="深蓝底和镂空字母", related_paths=[str(document)],
                                 aliases=["logo", "品牌标志"])
    assert updated["aliases"] == ["logo", "品牌标志"]
    assert "scope: project:Alpha" in sidecar.read_text(encoding="utf-8")
    assert "镂空字母" in sidecar.read_text(encoding="utf-8")


def test_import_and_promotion_keep_scope_with_originals(setup_knowledge, tmp_path):
    knowledge, _, company, _ = setup_knowledge
    sample = tmp_path / "sample.png"
    Image.new("RGB", (8, 8)).save(sample)
    original = knowledge.import_file("sample.png", sample.read_bytes())
    sidecar = original.with_suffix(".md")
    private = knowledge.import_file("private.md", b"private note")
    knowledge.annotate(str(original), aliases=["标志"], description="蓝色", related_paths=[str(private)])
    result = knowledge.promote(str(original))
    target = Path(result["path"])
    assert target.is_relative_to(company / "knowledge")
    assert target.read_bytes() == original.read_bytes()
    assert sidecar.exists() and original.exists()
    assert "scope: company" in target.with_suffix(".md").read_text()
    assert result["aliases"] == ["标志"]
    assert result["related_paths"] == []
    assert str(private) not in target.with_suffix(".md").read_text()


def test_upload_preserves_source_and_accepts_authored_media_companion(setup_knowledge, tmp_path):
    knowledge, _, _, _ = setup_knowledge
    sample = tmp_path / "sample.png"
    Image.new("RGB", (8, 8)).save(sample)
    authored = b"---\ntitle: Sample\naliases: [sample, picture]\nmedia: ./logo.png\n---\nImage description\n"
    markdown = b"---\nsource: https://example.test/handbook\nscope: company\n---\nOriginal source contents\n"
    logo, companion, original = knowledge.import_files([("logo.png", sample.read_bytes()), ("logo.md", authored), ("book.md", markdown)])
    assert original.read_bytes() == markdown
    assert "scope: project:Alpha" in companion.read_text()
    assets = {Path(asset["path"]): asset for asset in knowledge.catalog()["items"]}
    assert set(assets) == {logo, original}
    assert assets[logo]["description"] == "Image description"
    assert assets[logo]["aliases"] == ["sample", "picture"]


def test_old_annotations_migrate_to_markdown_without_overwriting_later_edits(setup_knowledge, tmp_path):
    import json

    knowledge, _, _, _ = setup_knowledge
    logo = knowledge.root / "logo.png"
    Image.new("RGB", (8, 8)).save(logo)
    document = knowledge.root / "notes.md"
    document.write_text("Shared only after approval")
    knowledge.legacy_notes.write_text(json.dumps({"logo.png": {"alias": "旧名", "description": "以前的描述",
                                                               "related_paths": [str(document), str(tmp_path / "foreign")]}}))
    item = next(asset for asset in knowledge.catalog()["items"] if asset["path"] == str(logo))
    assert item["aliases"] == ["旧名"]
    assert item["description"] == "以前的描述"
    assert item["related_paths"] == [str(document)]
    companion = logo.with_suffix(".md")
    assert companion.exists() and "scope: project:Alpha" in companion.read_text()
    companion.write_text(companion.read_text().replace("旧名", "新名"))
    item = next(asset for asset in knowledge.catalog()["items"] if asset["path"] == str(logo))
    assert item["aliases"] == ["新名"]


async def test_skills_use_own_collection_and_reject_symlinked_index_files(setup_knowledge, tmp_path):
    knowledge, bridge, _, _ = setup_knowledge
    root = knowledge.home / "library" / "skills-index"
    root.mkdir(parents=True)
    skill = root / "brand.md"
    skill.write_text("---\ntitle: 品牌命名\nscope: skills\nkind: skill\n---\nskill-lookup")
    outside = tmp_path / "outside.md"
    outside.write_text(skill.read_text())
    (root / "outside.md").symlink_to(outside)
    assert [item["title"] for item in knowledge.catalog(scope="skills")["items"]] == ["品牌命名"]
    results = await knowledge.search("skill-lookup", scope="skills", kind="skill")
    assert [Path(hit["asset"]["path"]) for hit in results["items"]] == [skill]
    assert bridge.calls[-1] == ("skills", {"skills"}, "skill")
    assert (await knowledge.search("skill-lookup"))["items"] == []


async def test_index_snapshot_cannot_be_overtaken_by_same_scope_query(setup_knowledge, monkeypatch):
    import asyncio

    knowledge, bridge, company, _ = setup_knowledge
    first = knowledge.import_file("alpha.md", b"obsoleteprice 9")
    initial_query_entered, release_initial_query = asyncio.Event(), asyncio.Event()
    original_search = bridge.search

    async def search(collection, query, **kwargs):
        if query == "obsoleteprice":
            initial_query_entered.set()
            await release_initial_query.wait()
        return await original_search(collection, query, **kwargs)

    monkeypatch.setattr(bridge, "search", search)
    previous = asyncio.create_task(knowledge.search("obsoleteprice"))
    await asyncio.wait_for(initial_query_entered.wait(), 5)
    next_task = None
    try:
        first.write_text("currentprice 12")
        second = Knowledge(knowledge.home, knowledge.root, company_root=company, collection_search=bridge)
        next_task = asyncio.create_task(second.search("currentprice"))
        await asyncio.sleep(0.1)
        assert bridge.calls == []
    finally:
        release_initial_query.set()
        await asyncio.wait_for(asyncio.gather(*[task for task in (previous, next_task) if task is not None]), 10)
    assert "obsoleteprice" in previous.result()["items"][0]["snippet"]
    assert "currentprice" in next_task.result()["items"][0]["snippet"]


async def test_first_search_creates_companion_for_existing_media_without_overwriting_document(setup_knowledge):
    knowledge, _, _, _ = setup_knowledge
    image = knowledge.root / "logo.png"
    Image.new("RGB", (8, 8)).save(image)
    document = image.with_suffix(".md")
    original = b"# Logo\n![launch cover](logo.png)"
    document.write_bytes(original)
    result = await knowledge.search("launch cover", kind="image")
    assert result["items"][0]["asset"]["path"] == str(image)
    companion = image.with_name("logo.png.metadata.md")
    assert "media: logo.png" in companion.read_text()
    assert "scope: project:Alpha" in companion.read_text()
    assert document.read_bytes() == original
