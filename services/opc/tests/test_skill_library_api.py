"""Acceptance at the authenticated desktop route, with temporary company directories."""

import json
import shutil
from dataclasses import replace

import pytest
from starlette.testclient import TestClient

pytest.importorskip("aiopc.authorized_workspaces")
pytest.importorskip("aiopc.skillhub")

from aiopc.skillhub import tools
from aiopc.skillhub.audit import AuditResult
from aiopc.skillhub.manifest import SkillRecord, hash_skill, skill_content, write_manifest
from aiopc.skillhub.view import render_index

from aiopc.server import create_api


@pytest.fixture
def desktop(tmp_path, monkeypatch):
    company = tmp_path / "公司"
    alpha = company / "projects" / "Alpha"
    beta = company / "projects" / "Beta"
    outside = tmp_path / "另一家公司" / "projects" / "Other"
    for path in (alpha, beta, outside):
        path.mkdir(parents=True)
    (company / "projects" / "Alias").symlink_to(beta, target_is_directory=True)
    home = tmp_path / "home"
    library = home / "library"
    fixture = tmp_path / "source"
    fixture.mkdir()
    source = "---\nname: clone-page\ndescription: Recreate a marketing page\n---\n# Procedure\n"
    (fixture / "SKILL.md").write_text(source)
    passed = AuditResult("passed", ())
    skill = SkillRecord(
        id="b" * 24, repository="owner/repo", commit="a" * 40, source_path="clone-page/SKILL.md",
        source_url="https://github.com/owner/repo/blob/" + "a" * 40 + "/clone-page/SKILL.md", license="MIT",
        categories=("marketing",), names={"zh": ("复刻营销页",)}, descriptions={"zh": ("根据参考页重建营销页",)},
        has_scripts=False, content_hash=hash_skill(fixture), specification=passed, scan=passed, title="clone-page",
    )
    blocked = replace(skill, id="c" * 24, scan=AuditResult("failed", ()))
    shutil.copytree(fixture, skill_content(library, skill))
    shutil.copytree(fixture, skill_content(library, blocked))
    index = library / "skills-index"
    index.mkdir()
    document = index / f"{skill.id}.md"
    document.write_text(render_index(skill, source))
    write_manifest(library, {item.id: item for item in (skill, blocked)}, {}, {})

    async def search(_self, collection, query, **_kwargs):
        assert (collection, query) == ("skills", "复刻营销页")
        return [{"scope": "skills", "source_path": str(document), "snippet": "项目步骤",
                 "frontmatter": {"id": skill.id, "content_hash": skill.content_hash}}]

    monkeypatch.setattr(tools._QmdSearch, "search", search)
    client = TestClient(create_api(home, "skill-test", authorized_roots=[company]),
                        headers={"Authorization": "Bearer skill-test"})
    return client, company, alpha, beta, outside, skill, blocked


def test_search_and_adopt_share_the_index_and_hash_lock(desktop):
    client, company, alpha, beta, _, skill, _ = desktop
    params = {"workspace": str(company)}
    result = client.get("/api/skillhub/search", params={**params, "q": "复刻营销页"})
    assert result.status_code == 200, result.text
    assert result.json()["candidates"][0]["id"] == skill.id
    adoption = {"id": skill.id, "commit": skill.commit, "scope": "project", "project": "Alpha"}
    installed = client.post("/api/skillhub/adopt", params=params, json=adoption)
    assert installed.status_code == 200, installed.text
    assert installed.json()["installed"] is True
    lock = json.loads((alpha / ".opencode" / "skills-lock.json").read_text())
    assert lock["skills"]["clone-page"]["hash"] == skill.content_hash
    assert (alpha / ".opencode" / "skills" / "clone-page" / "SKILL.md").is_file()
    assert not (beta / ".opencode").exists()
    assert client.post("/api/skillhub/adopt", params=params, json=adoption).json()["installed"] is False

    # A valid project name can match the name of the project's parent directory.
    nested = company / "projects" / "projects"
    nested.mkdir()
    response = client.post("/api/skillhub/adopt", params=params, json={**adoption, "project": "projects"})
    assert response.status_code == 200, response.text
    assert (nested / ".opencode" / "skills-lock.json").exists()

    promoted = client.post("/api/skillhub/adopt", params=params,
                           json={"id": skill.id, "commit": skill.commit, "scope": "company"})
    assert promoted.status_code == 200, promoted.text
    assert (company / ".opencode" / "skills-lock.json").exists()


def test_adoption_rejects_untrusted_paths_stale_revision_and_failed_audit(desktop):
    client, company, alpha, beta, outside, skill, blocked = desktop
    route = "/api/skillhub/adopt"
    payload = {"id": skill.id, "commit": skill.commit, "scope": "project", "project": "Alpha"}
    for workspace in (outside, alpha):
        assert client.post(route, params={"workspace": str(workspace)}, json=payload).status_code == 403
    params = {"workspace": str(company)}
    for changes in ({"project": str(outside)}, {"project": "Alias"}, {"commit": "old"}, {"id": blocked.id},
                    {"scope": "company", "project": "Beta"}):
        assert client.post(route, params=params, json={**payload, **changes}).status_code == 400
    assert client.post(route, params={**params, "token": "skill-test"}, headers={"Authorization": ""},
                       json=payload).status_code == 401
    assert all(not (path / ".opencode").exists() for path in (company, alpha, beta, outside))
