import sys

import pytest

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
