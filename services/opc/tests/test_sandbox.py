"""Environments: choosing one, remembering it, and talking to the ones in the cloud."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from aiopc.sandbox import Sandboxes
from aiopc.sandbox.environment import ProjectKey, SandboxError
from aiopc.sandbox.remote import REMOTE_CATALOG, RemoteProvider, fill, pick


def test_a_project_keeps_a_readable_stable_name():
    first = ProjectKey(path="/Users/a/work/my project")
    assert first.slug == ProjectKey(path="/Users/a/work/my project").slug
    assert first.slug.startswith("my-project-")
    assert ProjectKey(path="/Users/a/work/other").slug != first.slug


def test_the_local_sandbox_is_always_offered(tmp_path):
    providers = asyncio.run(Sandboxes(tmp_path).describe_providers())
    assert providers[0]["id"] == "local"
    assert {"kernel", "browserbase", "steel", "hyperbrowser", "anchor", "browseruse", "manual"} <= {
        item["id"] for item in providers}
    assert all(item["summary"] for item in providers)


def test_a_cloud_provider_needs_its_key_before_a_project_can_move(tmp_path):
    sandboxes = Sandboxes(tmp_path)
    with pytest.raises(SandboxError):
        asyncio.run(sandboxes.move("/p", "kernel"))
    sandboxes.configure("kernel", {"api_key": "k-123"})
    assert sandboxes.configured("kernel")
    asyncio.run(sandboxes.move("/p", "kernel"))
    assert sandboxes.record("/p")["provider"] == "kernel"
    # Clearing the key puts the project's choice back to what always works.
    sandboxes.configure("kernel", {"api_key": ""})
    assert not sandboxes.configured("kernel")


def test_a_missing_required_field_is_named(tmp_path):
    with pytest.raises(SandboxError, match="Project ID"):
        Sandboxes(tmp_path).configure("browserbase", {"api_key": "k"})


def test_the_request_table_fills_in_what_the_service_asked_for():
    assert fill("/browsers/{session}", {"session": "s1"}) == "/browsers/s1"
    body = fill({"profile": {"name": "{profile}", "save": True}, "empty": "{missing}"}, {"profile": "p1"})
    assert body == {"profile": {"name": "p1", "save": True}}
    assert pick({"data": {"cdp_url": "wss://x"}}, "data.cdp_url") == "wss://x"
    assert pick({"data": None}, "data.cdp_url") == ""


REAL_CLIENT = httpx.AsyncClient


def _answering(monkeypatch, answers: dict[tuple[str, str], dict] | None = None, *, status: int = 200, text: str = ""):
    """Let the table talk to a service that only exists in this test."""
    seen: list[tuple[str, str, dict | None, dict]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        seen.append((request.method, request.url.path, body, dict(request.headers)))
        if status >= 400:
            return httpx.Response(status, text=text)
        return httpx.Response(status, json=(answers or {}).get((request.method, request.url.path), {}))

    monkeypatch.setattr(httpx, "AsyncClient",
                        lambda **kwargs: REAL_CLIENT(transport=httpx.MockTransport(handler)))
    return seen


def test_a_cloud_environment_is_created_from_its_table(monkeypatch):
    kernel = next(spec for spec in REMOTE_CATALOG if spec.info.id == "kernel")
    seen = _answering(monkeypatch, {
        ("POST", "/profiles"): {"id": "pr_1", "name": "shop-1234abcd"},
        ("POST", "/browsers"): {"session_id": "br_1", "cdp_ws_url": "wss://cdp", "browser_live_view_url": "https://view"},
    })

    state = {"_secret": {"api_key": "k-1"}}
    environment = asyncio.run(RemoteProvider(kernel).ensure(ProjectKey(path="/Users/a/shop"), state))

    assert environment.running and environment.cdp_url == "wss://cdp" and environment.live_view_url == "https://view"
    assert state["session"] == "br_1" and state["profile"] == "shop-1234abcd"
    # The profile is created first, under the project's own name, and the browser keeps its changes.
    assert seen[0][1] == "/profiles" and seen[0][2] == {"name": ProjectKey(path="/Users/a/shop").slug}
    assert seen[1][2]["profile"] == {"name": state["profile"], "save_changes": True}
    assert seen[1][3]["authorization"] == "Bearer k-1"


def test_a_service_that_hands_out_the_picture_separately(monkeypatch):
    browserbase = next(spec for spec in REMOTE_CATALOG if spec.info.id == "browserbase")
    seen = _answering(monkeypatch, {
        ("POST", "/v1/contexts"): {"id": "ctx_1"},
        ("POST", "/v1/sessions"): {"id": "ses_1", "connectUrl": "wss://connect"},
        ("GET", "/v1/sessions/ses_1/debug"): {"debuggerFullscreenUrl": "https://live"},
    })

    state = {"_secret": {"api_key": "k", "project_id": "p1"}}
    environment = asyncio.run(RemoteProvider(browserbase).ensure(ProjectKey(path="/Users/a/shop"), state))

    assert environment.cdp_url == "wss://connect" and environment.live_view_url == "https://live"
    assert ("GET", "/v1/sessions/ses_1/debug") in [(method, path) for method, path, _, _ in seen]


def test_a_cloud_refusal_is_said_in_words(monkeypatch):
    kernel = next(spec for spec in REMOTE_CATALOG if spec.info.id == "kernel")

    _answering(monkeypatch, status=402, text="out of credit")
    with pytest.raises(SandboxError, match="Kernel"):
        asyncio.run(RemoteProvider(kernel).ensure(ProjectKey(path="/p"), {"_secret": {"api_key": "k"}}))


def test_an_environment_of_your_own_needs_only_an_address(tmp_path):
    sandboxes = Sandboxes(tmp_path)
    sandboxes.configure("manual", {"cdp_url": "ws://127.0.0.1:9222"})
    asyncio.run(sandboxes.move("/p", "manual"))
    environment = asyncio.run(sandboxes.ensure("/p"))
    assert environment.running and environment.cdp_url == "ws://127.0.0.1:9222"


def test_built_in_accounts_move_with_their_logins(tmp_path):
    """Moving to an environment keeps the accounts whose logins came across, checked where AIOPC can check."""
    from aiopc.social.service import SocialService

    social = SocialService(tmp_path / "home", tmp_path / "shop")
    social.store.upsert("xhs", {"id": "u1", "name": "老号"}, engine="embedded")
    social.store.upsert("x", {"id": "x1", "name": "gone"}, engine="embedded")
    social.store.upsert("wechat", {"id": "browser-wechat", "name": "公众号账号"}, engine="embedded")

    class Sandbox:
        async def account(self, platform):
            # 小红书 is logged in there; X's login did not survive the move.
            return {"id": "u1", "name": "老号"} if platform == "xhs" else None

    adopted = asyncio.run(social._adopt_builtin_accounts(Sandbox()))

    assert sorted(adopted) == ["wechat", "xhs"]
    social.set_engine("sandbox")
    assert sorted(account["platform"] for account in social.accounts()) == ["wechat", "xhs"]


def test_the_choice_of_browser_is_remembered(tmp_path):
    sandboxes = Sandboxes(tmp_path)
    record = sandboxes.record("/p")
    record["engine"] = "embedded"
    sandboxes.save("/p", record)
    assert sandboxes.record("/p")["engine"] == "embedded"
    # Moving to another provider keeps it.
    sandboxes.configure("manual", {"cdp_url": "ws://127.0.0.1:9222"})
    asyncio.run(sandboxes.move("/p", "manual"))
    assert sandboxes.record("/p")["engine"] == "embedded"
