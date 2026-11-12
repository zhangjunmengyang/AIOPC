import json
import sys

import pytest

from aiopc import credentials
from aiopc.collection_search import CollectionSearch, CollectionSearchError


async def test_collection_registration_scope_filter_and_refresh(tmp_path):
    root = tmp_path / "markdown"
    root.mkdir()
    worker = tmp_path / "worker.py"
    worker.write_text("""
import json
import sys
from pathlib import Path

request = json.load(sys.stdin)
assert request["collection"] == "skills"
assert request["root"] == sys.argv[1]
assert Path(request["dbPath"]).parent.is_dir()
assert request["scopes"] == ["skills"]
if request["operation"] == "refresh":
    print(json.dumps({"indexed": 1}))
else:
    assert request["query"] == "复刻营销页" and request["kind"] == "skill"
    hit = {"title": "Landing page", "snippet": "Marketing", "scope": "skills",
           "score": 1, "frontmatter": {"scope": "skills", "kind": "skill"}}
    print(json.dumps([
        dict(hit, source_path="skill.md"),
        dict(hit, source_path="../secret.md"),
        dict(hit, source_path="private.md", scope="project:private"),
    ]))
""")
    (root / "skill.md").touch()
    bridge = CollectionSearch(tmp_path / "home", command=(sys.executable, "-I", str(worker), str(root)), environment={})
    bridge.register("skills", root)
    assert await bridge.refresh("skills", scopes=["skills"]) == {"indexed": 1}
    result = await bridge.search("skills", "复刻营销页", scopes=["skills", "skills"], kind="skill")
    assert len(result) == 1
    assert result[0]["source_path"] == "skill.md"
    assert result[0]["frontmatter"]["kind"] == "skill"
    with pytest.raises(CollectionSearchError, match="未注册"):
        await bridge.search("unregistered", "x", scopes=["skills"])


async def test_provider_credentials_are_only_in_private_worker_request(tmp_path, monkeypatch):
    root = tmp_path / "markdown"
    root.mkdir()
    worker = tmp_path / "worker.py"
    worker.write_text("""
import json
import os
import sys

request = json.load(sys.stdin)
assert request["embedding"] == {
    "provider": "openai", "baseUrl": "http://127.0.0.1:1234/v1",
    "model": "mock", "dimensions": 4, "apiKey": "mock-secret",
}
assert "AIOPC_KB_EMBEDDING_API_KEY" not in os.environ
assert "mock-secret" not in sys.argv
print("mock-secret", file=sys.stderr)
sys.exit(1)
""")
    monkeypatch.setenv("AIOPC_KB_EMBEDDING_API_KEY", "mock-secret")
    bridge = CollectionSearch(tmp_path / "home", command=(sys.executable, "-I", str(worker)), environment={
        "AIOPC_KB_EMBEDDING_PROVIDER": "openai",
        "AIOPC_KB_EMBEDDING_BASE_URL": "http://127.0.0.1:1234/v1",
        "AIOPC_KB_EMBEDDING_MODEL": "mock",
        "AIOPC_KB_EMBEDDING_DIMENSIONS": "4",
        "AIOPC_KB_EMBEDDING_API_KEY": "mock-secret",
    })
    bridge.register("skills", root)
    with pytest.raises(CollectionSearchError, match="qmd") as error:
        await bridge.search("skills", "foo", scopes=["skills"])
    assert "mock-secret" not in str(error.value)


@pytest.mark.parametrize(("collection", "scopes", "environment", "provider"), [
    ("knowledge-project", ("project:demo",), {}, "openai"),
    ("knowledge-company", ("company",), {}, None),
    ("knowledge-combined", ("project:demo", "company"), {}, None),
    ("skills", ("skills",), {}, None),
    ("knowledge-project", ("project:demo",), {"AIOPC_KB_EMBEDDING_PROVIDER": ""}, None),
    ("knowledge-project", ("project:demo",), {"AIOPC_KB_EMBEDDING_PROVIDER": "off"}, None),
    ("knowledge-project", ("project:demo",), {
        "AIOPC_KB_EMBEDDING_PROVIDER": "ollama", "AIOPC_KB_EMBEDDING_MODEL": "explicit",
    }, "ollama"),
])
async def test_legacy_embedding_only_applies_to_one_project_without_explicit_config(
    tmp_path, monkeypatch, collection, scopes, environment, provider,
):
    root = tmp_path / "markdown"
    root.mkdir()
    home = tmp_path / "home"
    home.mkdir()
    profile = home / "embedding-profile.json"
    profile.write_text(json.dumps({"base_url": "http://127.0.0.1:1234/v1/", "model": "old-model"}))
    worker = tmp_path / "worker.py"
    worker.write_text("""
import json
import os
import sys

request = json.load(sys.stdin)
assert all("legacy-test-secret" not in argument for argument in sys.argv)
assert all("legacy-test-secret" not in value for value in os.environ.values())
print(json.dumps({"embedding": request.get("embedding")}))
""")
    reads = []

    def read_key(*identity):
        reads.append(identity)
        return {"api_key": "legacy-test-secret"}

    monkeypatch.setattr(credentials, "load", read_key)
    bridge = CollectionSearch(home, command=(sys.executable, "-I", str(worker)), environment=environment)
    bridge.register(collection, root)
    result = await bridge.refresh(collection, scopes=scopes)
    if provider == "openai":
        assert reads == [("models", "embedding")]
        assert result["embedding"] == {
            "provider": "openai", "model": "old-model", "baseUrl": "http://127.0.0.1:1234/v1",
            "apiKey": "legacy-test-secret",
        }

        monkeypatch.setattr(credentials, "load", lambda *_: None)
        assert (await bridge.refresh(collection, scopes=scopes))["embedding"] is None
    else:
        assert not reads
        expected = {"provider": provider, "model": "explicit", "baseUrl": "http://127.0.0.1:11434"} if provider else None
        assert result["embedding"] == expected
