import asyncio
from dataclasses import replace

import pytest

from aiopc.skillhub.audit import AuditResult
from aiopc.skillhub.manifest import (
    SkillRecord,
    hash_skill,
    skill_content,
    write_manifest,
)
from aiopc.skillhub.search import SkillHub
from aiopc.skillhub.view import render_index


@pytest.fixture
def skill(tmp_path):
    source = tmp_path / "content"
    source.mkdir()
    (source / "SKILL.md").write_text("---\nname: clone-page\ndescription: Recreate marketing pages\n---\n# Workflow\n")
    passed = AuditResult("passed", ())
    return SkillRecord(
        id="b" * 24, repository="owner/repo", commit="a" * 40, source_path="clone-page/SKILL.md",
        source_url="https://github.com/owner/repo/blob/" + "a" * 40 + "/clone-page/SKILL.md",
        license="MIT", categories=("marketing",), names={"en": ("Clone a page",), "zh": ("复刻营销页",)},
        descriptions={"en": ("Recreate a marketing page",), "zh": ("根据参考页重建营销页",)},
        has_scripts=True, content_hash=hash_skill(source), specification=passed, scan=passed, title="clone-page",
    )


def test_content_hash_is_portable_and_refuses_links(tmp_path, skill):
    source = tmp_path / "content"
    assert hash_skill(source) == skill.content_hash
    assert skill_content(tmp_path, skill) == tmp_path / "skills-mirror" / skill.id / skill.content_hash
    (source / "SKILL.md").write_text("modified")
    assert hash_skill(source) != skill.content_hash
    (source / "escape").symlink_to(tmp_path)
    with pytest.raises(ValueError, match="escape"):
        hash_skill(source)
    with pytest.raises(ValueError):
        skill_content(tmp_path, replace(skill, id="../escape"))


def test_index_view_uses_both_languages_and_scope(skill):
    view = render_index(skill, "# Workflow\n")
    assert view.startswith("---\n")
    for expected in ["scope: skills", "kind: skill", "复刻营销页", "根据参考页重建营销页",
                     "Recreate a marketing page", "has_scripts: true", "# Workflow", skill.content_hash]:
        assert expected in view


def test_search_checks_collection_root_scope_and_generation(tmp_path, skill):
    index = tmp_path / "skills-index"
    index.mkdir()
    source = index / f"{skill.id}.md"
    source.write_text(render_index(skill, "# Workflow\n"))
    write_manifest(tmp_path, {skill.id: skill}, {}, {})

    class FakeSearch:
        async def search(self, collection, query, *, scopes, kind=None, limit=10):
            assert (collection, query, scopes, kind, limit) == ("skills", "复刻营销页", ("skills",), "skill", 5)
            hit = {"source_path": str(source), "title": "Clone a page", "snippet": "根据参考页重建营销页",
                   "scope": "skills", "score": 0.8, "frontmatter": {"id": skill.id, "content_hash": skill.content_hash}}
            return [
                {**hit, "scope": "company"},
                {**hit, "source_path": str(tmp_path / f"{skill.id}.md")},
                {**hit, "frontmatter": {"id": skill.id, "content_hash": "stale"}},
                hit,
                hit,
            ]

    result = asyncio.run(SkillHub(tmp_path, FakeSearch()).find_skill("复刻营销页"))
    assert len(result["candidates"]) == 1
    candidate = result["candidates"][0]
    assert candidate["id"] == skill.id
    assert candidate["has_scripts"] is True
    assert candidate["execution"] == "sandbox-only"
    assert candidate["descriptions"]["zh"] == ["根据参考页重建营销页"]
    assert candidate["source_url"] == skill.source_url
    assert candidate["score"] == 0.8


async def test_mcp_adoption_uses_verified_session_and_exposes_no_project_override(tmp_path, skill, monkeypatch):
    from types import SimpleNamespace

    from mcp.server.fastmcp import FastMCP

    from aiopc.skillhub import tools

    company = tmp_path / "company"
    alpha = company / "projects" / "alpha"
    alpha.mkdir(parents=True)
    library = tmp_path / "library"
    library.mkdir()
    write_manifest(library, {skill.id: skill}, {}, {})
    authority = SimpleNamespace(company=company, project_id="proj:alpha", project_directory=alpha)

    async def resolve(meta):
        assert meta == {"trusted": True}
        return authority

    def install(record, source, **kwargs):
        assert record == skill
        assert source == skill_content(library, skill)
        return kwargs

    monkeypatch.setattr(tools, "install_skill", install)
    server = FastMCP("test")
    tools.register_tools(server, tmp_path, resolve_session=resolve)
    schemas = {item.name: item.inputSchema for item in await server.list_tools()}
    assert set(schemas["adopt_skill"]["properties"]) == {"id", "scope"}
    assert set(schemas["find_skill"]["properties"]) == {"query"}
    fn = server._tool_manager.get_tool("adopt_skill").fn
    ctx = SimpleNamespace(request_context=SimpleNamespace(meta={"trusted": True}))
    result = await fn(id=skill.id, ctx=ctx)
    assert result == {"company": company, "project": alpha, "scope": "project", "can_adopt_company": False}
    authority.project_id = None
    authority.project_directory = company
    assert (await fn(id=skill.id, ctx=ctx, scope="company"))["can_adopt_company"] is True


async def test_catalog_glossary_retries_marketing_page_with_qmd(tmp_path, skill):
    index = tmp_path / "skills-index"
    index.mkdir()
    source = index / f"{skill.id}.md"
    source.write_text(render_index(skill, "# Landing page\n"))
    write_manifest(tmp_path, {skill.id: skill}, {}, {})
    queries = []

    class FakeSearch:
        async def search(self, collection, query, *, scopes, kind=None, limit=10):
            assert (collection, scopes, kind) == ("skills", ("skills",), "skill")
            assert limit == (20 if query == '"landing page"' else 5)
            queries.append(query)
            if query == '"landing page"':
                return [{"source_path": source.name, "title": skill.title, "scope": "skills", "score": 0.4,
                         "frontmatter": {"id": skill.id, "content_hash": skill.content_hash}}]
            return []

    result = await SkillHub(tmp_path, FakeSearch()).find_skill("复刻营销页")
    assert queries == ["复刻营销页", '"landing page"']
    assert result["matched_query"] == '"landing page"'
    assert [candidate["id"] for candidate in result["candidates"]] == [skill.id]


async def test_mcp_adopts_script_skill_without_exposing_the_private_bundle(tmp_path, skill):
    import json
    from types import SimpleNamespace

    from mcp.server.fastmcp import FastMCP

    from aiopc.skillhub.tools import register_tools

    library = tmp_path / "library"
    company = tmp_path / "company"
    project = company / "projects" / "alpha"
    project.mkdir(parents=True)
    source = tmp_path / "content"
    script = source / "scripts" / "sample.sh"
    script.parent.mkdir()
    script.write_text("#!/bin/sh\nexit 0\n")
    skill = replace(skill, content_hash=hash_skill(source))
    bundle = skill_content(library, skill)
    bundle.parent.mkdir(parents=True)
    source.rename(bundle)
    write_manifest(library, {skill.id: skill}, {}, {})

    async def resolve(meta):
        assert meta == {"trusted": True}
        return SimpleNamespace(company=company, project_id="proj:alpha", project_directory=project)

    server = FastMCP("test")
    register_tools(server, tmp_path, resolve_session=resolve)
    install = server._tool_manager.get_tool("adopt_skill").fn
    ctx = SimpleNamespace(request_context=SimpleNamespace(meta={"trusted": True}))
    result = await install(id=skill.id, ctx=ctx)
    assert result["installed"] and result["has_scripts"]
    assert str(library) not in json.dumps(result)
    installed = project / ".opencode/skills/clone-page"
    stub = (installed / "SKILL.md").read_text()
    assert "run_skill_script" in stub
    assert str(library) not in stub
    assert not (installed / "scripts").exists()
    assert (bundle / "scripts/sample.sh").is_file()
