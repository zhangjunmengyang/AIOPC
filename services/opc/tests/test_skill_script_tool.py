from pathlib import Path
from types import SimpleNamespace

import pytest
from mcp.server.fastmcp import FastMCP

from aiopc.sandbox.environment import SandboxError
from aiopc.skillhub import script_tool
from aiopc.skillhub.adopt import adopt_skill
from aiopc.skillhub.audit import AuditResult
from aiopc.skillhub.manifest import SkillRecord, hash_skill, skill_content, write_manifest


@pytest.fixture
def wired(tmp_path, monkeypatch):
    company = tmp_path / "company"
    project = company / "projects" / "Alpha"
    sibling = company / "projects" / "Beta"
    project.mkdir(parents=True)
    sibling.mkdir()
    source = tmp_path / "source"
    (source / "scripts").mkdir(parents=True)
    (source / "SKILL.md").write_text("---\nname: sample\ndescription: Script fixture\n---\nSample.\n")
    script = source / "scripts" / "fixture.py"
    script.write_text("print('fixture')\n")
    record = SkillRecord(
        id="b" * 24, repository="owner/repo", commit="a" * 40, source_path="sample/SKILL.md",
        source_url="https://example.invalid/skill", license="MIT", categories=(),
        names={}, descriptions={}, has_scripts=True, content_hash=hash_skill(source),
        specification=AuditResult("passed"), scan=AuditResult("passed"), title="Sample label",
    )
    library = tmp_path / "library"
    bundle = skill_content(library, record)
    bundle.parent.mkdir(parents=True)
    source.rename(bundle)
    write_manifest(library, {record.id: record}, {}, {})
    adopt_skill(record, bundle, company=company, project=project)
    adopt_skill(record, bundle, company=company, project=None, scope="company", can_adopt_company=True)
    authority = SimpleNamespace(company=company, project_id="proj:Alpha", project_directory=project, agent_name="designer")
    calls = []
    resolved = SimpleNamespace(provider="local")
    provider = object()

    class FakeSandboxes:
        def resolve(self, directory, environment):
            assert directory == str(project)
            if environment == "env-other":
                raise SandboxError("环境不属于项目")
            return {"provider": resolved.provider}

        def provider(self, key):
            assert key == resolved.provider
            return provider

    async def resolve_session(meta):
        assert meta == {"trusted": True}
        return authority

    async def authorize(identity, name, scope):
        assert identity is authority
        assert name == "sample"
        return scope == "project" and identity.agent_name == "designer"

    async def execute(actual_provider, path, entry, args, *, verify_staged):
        assert actual_provider is provider
        assert isinstance(path, Path) and path == bundle
        verify_staged(bundle)
        calls.append((entry, args, verify_staged))
        return {"exit_code": 0, "stdout": "fixture\n", "stderr": "", "truncated": False}

    monkeypatch.setattr(script_tool, "run_script_in_sandbox", execute)
    server = FastMCP("test")
    script_tool.register_script_tool(server, tmp_path, FakeSandboxes(), resolve_session=resolve_session, authorize=authorize)
    fn = server._tool_manager.get_tool("run_skill_script").fn
    ctx = SimpleNamespace(request_context=SimpleNamespace(meta={"trusted": True}))
    return SimpleNamespace(
        fn=fn, ctx=ctx, record=record, calls=calls, authority=authority, sibling=sibling, resolved=resolved,
        bundle=bundle, server=server,
    )


async def test_script_tool_uses_current_project_and_locked_bundle(wired):
    schema = (await wired.server.list_tools())[0].inputSchema
    assert set(schema["properties"]) == {"skill_id", "entry", "scope", "args", "environment"}
    result = await wired.fn(skill_id=wired.record.id, entry="scripts/fixture.py", args=["abc"], ctx=wired.ctx)
    assert result == {"exit_code": 0, "stdout": "fixture\n", "stderr": "", "truncated": False}
    assert [(entry, args) for entry, args, _ in wired.calls] == [("scripts/fixture.py", ["abc"])]
    (wired.bundle / "scripts" / "fixture.py").write_text("changed after authorization\n")
    with pytest.raises(ValueError, match="hash"):
        wired.calls[0][2](wired.bundle)


@pytest.mark.parametrize("failure", ["role", "scope", "sibling", "company", "environment", "remote"])
async def test_script_tool_denials_do_not_launch_runner(wired, failure):
    kwargs = {}
    if failure == "role":
        wired.authority.agent_name = "growth"
    if failure == "scope":
        kwargs["scope"] = "company"
    if failure == "sibling":
        wired.authority.project_id = "proj:Beta"
        wired.authority.project_directory = wired.sibling
    if failure == "company":
        wired.authority.project_id = None
        wired.authority.project_directory = wired.authority.company
    if failure == "environment":
        kwargs["environment"] = "env-other"
    if failure == "remote":
        wired.resolved.provider = "manual"
    with pytest.raises((ValueError, SandboxError)):
        await wired.fn(skill_id=wired.record.id, entry="scripts/fixture.py", ctx=wired.ctx, **kwargs)
    assert wired.calls == []
