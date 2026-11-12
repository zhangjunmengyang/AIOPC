import json
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

import pytest

from aiopc.skillhub.adopt import adopt_skill
from aiopc.skillhub.audit import AuditResult
from aiopc.skillhub.manifest import SkillRecord, hash_skill, skill_id


@pytest.fixture
def skill(tmp_path):
    source = tmp_path / "mirror" / "replicate-page"
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text("---\nname: replicate-page\ndescription: Reproduce a landing page.\n---\nRead the reference.\n")
    (source / "references").mkdir()
    (source / "references" / "structure.md").write_text("# Layout")
    repository = "https://github.com/example/skills"
    source_path = "skills/replicate-page/SKILL.md"
    commit = "a" * 40
    record = SkillRecord(
        id=skill_id(repository, source_path, commit), repository=repository, commit=commit,
        source_path=source_path, source_url=f"{repository}/blob/main/{source_path}",
        license="MIT", categories=("design",), names={}, descriptions={}, has_scripts=False, content_hash=hash_skill(source),
        specification=AuditResult("passed"), scan=AuditResult("passed"), title="复刻营销页",
    )
    return record, source


@pytest.fixture
def company(tmp_path):
    company = tmp_path / "company"
    (company / "projects" / "alpha").mkdir(parents=True)
    (company / "projects" / "beta").mkdir()
    return company


def test_project_adoption_copies_exact_content_and_is_idempotent(company, skill):
    record, source = skill
    project = company / "projects" / "alpha"
    kwargs = {"company": company, "project": project}
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(adopt_skill, record, source, **kwargs) for _ in range(4)]
        outcomes = [future.result() for future in futures]

    installed = project / ".opencode" / "skills" / "replicate-page"
    assert hash_skill(installed) == record.content_hash
    assert sorted(result["installed"] for result in outcomes) == [False, False, False, True]
    assert all(result["path"] == str(installed.resolve()) for result in outcomes)
    lock = json.loads((project / ".opencode" / "skills-lock.json").read_text())
    assert lock["skills"]["replicate-page"]["hash"] == record.content_hash
    assert lock["skills"]["replicate-page"]["id"] == record.id
    assert lock["skills"]["replicate-page"]["has_scripts"] is False
    assert not (company / "projects" / "beta" / ".opencode").exists()
    assert not (company / ".opencode").exists()


def test_company_scope_requires_explicit_company_context(company, skill):
    project = company / "projects" / "alpha"
    with pytest.raises(ValueError):
        adopt_skill(*skill, company=company, project=project, scope="company", can_adopt_company=True)
    with pytest.raises(ValueError):
        adopt_skill(*skill, company=company, project=None, scope="company")
    with pytest.raises(ValueError):
        adopt_skill(*skill, company=company, project=None)

    result = adopt_skill(*skill, company=company, project=None, scope="company", can_adopt_company=True)
    assert result["scope"] == "company"
    assert Path(result["path"]) == company.resolve() / ".opencode" / "skills" / "replicate-page"
    assert not (project / ".opencode").exists()


@pytest.mark.parametrize("boundary", ["outside", "project_alias", "config_alias", "skills_alias", "lock_alias", "mutex_hardlink"])
def test_adoption_rejects_paths_outside_trusted_target(company, skill, tmp_path, boundary):
    outside = tmp_path / "outside"
    outside.mkdir()
    project = company / "projects" / "alpha"
    if boundary == "outside":
        project = outside
    if boundary == "project_alias":
        project = company / "projects" / "alias"
        project.symlink_to(company / "projects" / "beta", target_is_directory=True)
    if boundary == "config_alias":
        (project / ".opencode").symlink_to(outside, target_is_directory=True)
    if boundary in {"skills_alias", "lock_alias", "mutex_hardlink"}:
        (project / ".opencode").mkdir()
        if boundary == "skills_alias":
            (project / ".opencode" / "skills").symlink_to(outside, target_is_directory=True)
        elif boundary == "lock_alias":
            (project / ".opencode" / "skills-lock.json").symlink_to(outside / "lock.json")
        else:
            protected = tmp_path / "protected.txt"
            protected.write_text("keep")
            os.link(protected, project / ".opencode" / ".skillhub-adopt.lock")

    with pytest.raises(ValueError):
        adopt_skill(*skill, company=company, project=project)
    assert list(outside.iterdir()) == []
    assert not (company / "projects" / "beta" / ".opencode").exists()
    if boundary == "mutex_hardlink":
        assert protected.read_text() == "keep"


@pytest.mark.parametrize("stage,status", [("specification", "failed"), ("scan", "failed"), ("scan", "unreachable"), ("scan", "skipped")])
def test_adoption_requires_both_audits_to_pass(company, skill, stage, status):
    record, source = skill
    project = company / "projects" / "alpha"
    with pytest.raises(ValueError, match=status):
        adopt_skill(replace(record, **{stage: AuditResult(status)}), source, company=company, project=project)
    assert not (project / ".opencode").exists()


@pytest.mark.parametrize("script", ["manifest", "scripts/tool.txt", "references/tool.sh", "references/tool"])
def test_script_content_is_never_installed_for_the_host_skill_tool(company, skill, script):
    record, source = skill
    project = company / "projects" / "alpha"
    if script == "manifest":
        record = replace(record, has_scripts=True)
    else:
        script_file = source / script
        script_file.parent.mkdir(exist_ok=True)
        script_file.write_text("#!/bin/sh\n# Fixture only; never execute.\n")
        record = replace(record, content_hash=hash_skill(source))

    with pytest.raises(ValueError, match="沙箱"):
        adopt_skill(record, source, company=company, project=project)
    assert not (project / ".opencode" / "skills" / "replicate-page").exists()


def test_mirror_modification_is_detected_before_install(company, skill):
    record, source = skill
    (source / "references" / "structure.md").write_text("changed")
    project = company / "projects" / "alpha"
    with pytest.raises(ValueError, match="hash"):
        adopt_skill(record, source, company=company, project=project)
    assert not (project / ".opencode" / "skills" / "replicate-page").exists()


@pytest.mark.parametrize("managed", [False, True])
def test_adoption_preserves_existing_or_edited_skill(company, skill, managed):
    project = company / "projects" / "alpha"
    installed = project / ".opencode" / "skills" / "replicate-page"
    if managed:
        adopt_skill(*skill, company=company, project=project)
    else:
        installed.mkdir(parents=True)
    path = installed / "SKILL.md"
    path.write_text("# local edits")

    with pytest.raises(ValueError):
        adopt_skill(*skill, company=company, project=project)
    assert path.read_text() == "# local edits"


def test_retry_repairs_a_lock_written_before_copy_became_visible(company, skill):
    project = company / "projects" / "alpha"
    outcome = adopt_skill(*skill, company=company, project=project)
    installed = Path(outcome["path"])
    installed.rename(installed.parent.parent / "interrupted")

    repaired = adopt_skill(*skill, company=company, project=project)
    assert repaired["installed"] is True
    assert hash_skill(installed) == skill[0].content_hash


def test_verified_mirror_leaves_script_payload_for_sandbox_integration(tmp_path):
    from aiopc.skillhub.adopt import verify_mirror

    source = tmp_path / "mirror"
    source.mkdir()
    (source / "SKILL.md").write_text("---\nname: demo\ndescription: Demo\n---\n")
    scripts = source / "scripts"
    scripts.mkdir()
    (scripts / "entry.sh").write_text("#!/bin/sh\nexit 0\n")
    passed = AuditResult("passed")
    record = SkillRecord(
        id="a" * 24, repository="org/repo", commit="a" * 40, source_path="demo/SKILL.md",
        source_url="https://github.com/org/repo", license=None, categories=(), names={}, descriptions={},
        has_scripts=True, content_hash=hash_skill(source), specification=passed, scan=passed, title="demo",
    )
    verify_mirror(record, source)
    (scripts / "entry.sh").write_text("changed")
    with pytest.raises(ValueError, match="hash"):
        verify_mirror(record, source)
