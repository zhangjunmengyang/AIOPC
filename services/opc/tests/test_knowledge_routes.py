from pathlib import Path

from starlette.testclient import TestClient

from aiopc.server import create_api, create_server


def test_knowledge_upload_catalog_and_preview_keep_company_and_project_separate(tmp_path):
    company = tmp_path / "company"
    alpha = company / "projects" / "alpha"
    beta = company / "projects" / "beta"
    alpha.mkdir(parents=True)
    beta.mkdir()
    api = TestClient(create_api(tmp_path / "home", "local-test", authorized_roots=[company]))
    headers = {"Authorization": "Bearer local-test"}

    def upload(project, scope, name):
        result = api.post("/api/knowledge/import", params={"workspace": str(project)}, headers=headers,
                          data={"scope": scope}, files={"files": (name, b"# Material", "text/markdown")})
        assert result.status_code == 200, result.json()
        return result.json()["items"][0]["path"]

    shared = upload(alpha, "company", "shared.md")
    private = upload(beta, "project", "beta.md")
    assert (company / "knowledge") in Path(shared).parents
    params = {"workspace": str(alpha)}
    company_items = api.get("/api/knowledge", params=params | {"scope": "company"}, headers=headers).json()["items"]
    assert {item["path"] for item in company_items} == {shared}
    assert api.get("/api/file", params=params | {"path": shared}, headers=headers).status_code == 200
    assert api.get("/api/file", params=params | {"path": private}, headers=headers).status_code == 400
    assert api.get("/api/knowledge", params=params | {"scope": "company"}).status_code == 401


def test_registered_company_under_projects_does_not_read_parent_knowledge(tmp_path):
    outside = tmp_path / "outside"
    company = outside / "projects" / "company"
    for root in (outside, company):
        (root / "knowledge").mkdir(parents=True, exist_ok=True)
        (root / "knowledge" / f"{root.name}.md").write_text(f"# {root.name}", encoding="utf-8")
    api = TestClient(create_api(tmp_path / "home", "local-test", authorized_roots=[company]))
    result = api.get("/api/knowledge", params={"workspace": str(company), "scope": "company"},
                     headers={"Authorization": "Bearer local-test"})
    assert result.status_code == 200, result.json()
    assert {item["path"] for item in result.json()["items"]} == {str(company / "knowledge" / "company.md")}


async def test_kb_query_is_only_knowledge_mcp_tool(tmp_path, monkeypatch):
    from aiopc.knowledge import Knowledge

    company = tmp_path / "company"
    alpha = company / "projects" / "alpha"
    alpha.mkdir(parents=True)
    calls = []

    async def search(self, query, limit=8, *, scope="project", kind=None, include_company=True):
        calls.append((self.root, query, limit, scope, kind, include_company))
        return {"items": []}

    monkeypatch.setattr(Knowledge, "search", search)
    server = create_server(tmp_path / "home", alpha)
    tools = {item.name: item for item in await server.list_tools()}
    assert "knowledge_query" not in tools
    assert set(tools["kb_query"].inputSchema["properties"]) == {"query", "scope", "kind", "limit"}
    await server.call_tool("kb_query", {"query": "标志", "kind": "image", "limit": 6})
    assert calls == [(alpha, "标志", 6, "project", "image", True)]


async def test_project_scope_and_associated_media_through_real_qmd(tmp_path, monkeypatch):
    import json
    import os
    import shutil

    import pytest
    from PIL import Image

    qmd = Path(__file__).resolve().parents[2] / "qmd"
    if not os.environ.get("AIOPC_QMD_RUNNER") and (not shutil.which("bun") or not (qmd / "node_modules").is_dir()):
        pytest.skip("prepare qmd dependencies or supply the packaged runner")
    monkeypatch.delenv("AIOPC_RUNTIME_CONTEXT_FILE", raising=False)
    monkeypatch.setenv("AIOPC_KB_EMBEDDING_PROVIDER", "")
    company = tmp_path / "company"
    alpha = company / "projects" / "alpha" / "knowledge"
    beta = company / "projects" / "beta" / "knowledge"
    outside = tmp_path / "unrelated" / "knowledge"
    for folder in (alpha, beta, company / "knowledge", outside):
        folder.mkdir(parents=True)
    (alpha / "brand.md").write_text("# Launch brand\n品牌发布手册 logo\n", encoding="utf-8")
    (beta / "private.md").write_text("# Second design\n品牌发布手册 logo\n", encoding="utf-8")
    (company / "knowledge" / "shared.md").write_text("# Company guide\n品牌发布手册 logo\n", encoding="utf-8")
    (outside / "other.md").write_text("# Other company\n品牌发布手册 logo\n", encoding="utf-8")
    Image.new("RGB", (8, 8)).save(alpha / "cover.png")
    (alpha / "cover.md").write_text(
        "---\ntitle: Launch cover\naliases: [首发主视觉, launch artwork]\nmedia: ./cover.png\n"
        "related: [brand.md]\nscope: company\n---\n深蓝标志\n", encoding="utf-8",
    )
    server = create_server(tmp_path / "home", alpha.parent)

    async def query(**args):
        result = await server.call_tool("kb_query", args)
        if isinstance(result, tuple):
            result = result[0]
        return json.loads(result[0].text)

    default = await query(query="品牌发布手册")
    by_name = {item["asset"]["name"]: item for item in default["items"]}
    assert set(by_name) == {"brand.md", "shared.md"}
    assert any(related["name"] == "cover.png" for related in by_name["brand.md"]["related"])
    assert by_name["brand.md"]["scope"] == "project:alpha"
    assert {item["asset"]["name"] for item in (await query(query="logo 品牌", scope="all"))["items"]} == {
        "brand.md", "shared.md", "private.md",
    }
    alias = await query(query="首发", kind="image")
    assert [item["asset"]["name"] for item in alias["items"]] == ["cover.png"]
    assert alias["items"][0]["scope"] == "project:alpha"
    assert (await query(query="首发", scope="company"))["items"] == []


async def test_desktop_knowledge_query_uses_host_project_and_requires_session_metadata(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace

    import pytest

    from aiopc.knowledge import Knowledge

    company = tmp_path / "company"
    project = company / "projects" / "alpha"
    project.mkdir(parents=True)
    monkeypatch.setenv("AIOPC_RUNTIME_CONTEXT_FILE", str(tmp_path / "local-discovery.json"))

    class MockResolver:
        def __init__(self, home):
            assert home == tmp_path / "home"

        async def resolve(self, metadata):
            if metadata != {"ai.opencode/sessionID": "ses_alpha"}:
                raise ValueError("missing trusted session")
            return SimpleNamespace(company=company, project_directory=project)

    async def search(self, query, limit, *, scope, kind):
        return {"workspace": str(self.root), "company": str(self.company_root), "scope": scope}

    monkeypatch.setitem(sys.modules, "aiopc.runtime_context", SimpleNamespace(RuntimeContextResolver=MockResolver))
    monkeypatch.setattr(Knowledge, "search", search)
    server = create_server(tmp_path / "home", company)
    query = server._tool_manager.get_tool("kb_query").fn
    ctx = SimpleNamespace(request_context=SimpleNamespace(meta={"ai.opencode/sessionID": "ses_alpha"}))
    assert await query("标志", ctx=ctx, scope="all") == {
        "workspace": str(project), "company": str(company), "scope": "all",
    }
    with pytest.raises(ValueError, match="missing trusted session"):
        await query("标志", ctx=SimpleNamespace(request_context=SimpleNamespace(meta=None)))


async def test_generated_image_records_document_link_and_rejects_outside_sources(tmp_path, monkeypatch):
    import pytest
    from PIL import Image

    from aiopc.knowledge import Knowledge
    from aiopc.media.image import ImageService

    project = tmp_path / "project"
    project.mkdir()
    source = project / "brand.md"
    source.write_text("# Brand")
    output = project / "image.png"
    Image.new("RGB", (8, 8)).save(output)
    called = []

    async def generate(self, prompt, aspect_ratio, reference_images, count):
        called.append(prompt)
        return {"images": [str(output)], "edited_from": []}

    monkeypatch.setattr(ImageService, "generate", generate)
    server = create_server(tmp_path / "home", project)
    await server.call_tool("generate_image", {"prompt": "生成品牌图", "source_documents": ["brand.md"]})
    library = Knowledge(tmp_path / "home", project)
    generated = next(asset for asset in library.catalog()["items"] if asset["path"] == str(output))
    assert generated["description"].startswith("生成要求：")
    assert generated["relations"][0]["path"] == str(source)
    outside = tmp_path / "outside.md"
    outside.write_text("# Outside")
    with pytest.raises(Exception, match="不属于当前知识库"):
        await server.call_tool("generate_image", {"prompt": "不应执行", "source_documents": [str(outside)]})
    assert called == ["生成品牌图"]
