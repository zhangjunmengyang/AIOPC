import asyncio
import urllib.parse

import pytest

from aiopc.accounts import AccountStore
from aiopc.social import routes
from aiopc.social.routes import BlueskyRoute, oauth1_header, x_weighted_length
from aiopc.social.service import SocialError, SocialService


class FakeBrowser:
    def __init__(self):
        self.composed = []

    async def compose(self, platform, form, **kwargs):
        self.composed.append((platform, form, kwargs["text"]))
        return {"page_url": "https://x.com/compose/post", "tab_id": "t1", "platform_key": "DYNAMIC_X"}


def make(tmp_path, platform="x", identity=None):
    browser = FakeBrowser()
    social = SocialService(tmp_path / "home", tmp_path, browser=browser)
    account = AccountStore(tmp_path / "home").upsert(platform, identity or {"id": "1", "name": "me", "handle": "me"})
    return social, browser, account


def test_browser_is_the_default_route(tmp_path):
    social, browser, account = make(tmp_path)
    result = asyncio.run(social.publish(account["id"], "hello"))
    assert result["status"] == "composer_filled" and result["route"] == "项目环境"
    assert browser.composed == [("x", "post", "hello")]
    assert social.history()[0]["route"] == "browser"


def test_official_api_never_publishes_instead_of_filling_composer(tmp_path, monkeypatch):
    social, browser, account = make(tmp_path)
    AccountStore(tmp_path / "home").set_route(account["id"], "x-api", {"username": "me"})
    sent = []

    async def publish(self, account, post):
        sent.append(post.text)
        return {"status": "published", "url": "https://x.com/me/status/9", "post_id": "9"}

    monkeypatch.setattr(routes.XApiRoute, "publish", publish)
    described = social.describe(AccountStore(tmp_path / "home").get(account["id"]))
    assert described["publish"] == "compose" and described["routes"][0]["id"] == "x-api"

    result = asyncio.run(social.publish(account["id"], "短帖", tags=["opc"]))
    assert result["status"] == "composer_filled" and sent == []
    assert social.history()[0]["action"] == "compose"

    image = tmp_path / "a.png"
    image.write_bytes(b"png")
    result = asyncio.run(social.publish(account["id"], "带图", media=[str(image)]))
    assert result["status"] == "composer_filled" and browser.composed[-1][2] == "带图"


def test_platform_without_composer_says_so(tmp_path):
    social, _, account = make(tmp_path, platform="github", identity={"id": "g", "name": "me"})
    with pytest.raises(SocialError, match="不能自动填写发布页"):
        asyncio.run(social.publish(account["id"], "hi"))


def test_oauth1_matches_x_documentation_example():
    # From X's "Creating a signature" guide.
    keys = {"api_key": "xvz1evFS4wEEPTGEFPHBog", "api_secret": "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
            "access_token": "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
            "access_token_secret": "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE"}
    url = "https://api.twitter.com/1.1/statuses/update.json"
    query = {"include_entities": "true", "status": "Hello Ladies + Gentlemen, a signed OAuth request!"}
    header = oauth1_header("POST", url, keys, query, nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", timestamp="1318622958")
    signature = dict(part.split("=", 1) for part in header.removeprefix("OAuth ").split(", "))["oauth_signature"]
    assert urllib.parse.unquote(signature.strip('"')) == "hCtSmYh+iHYCEqBWrE7C7hYmtUk="


def test_x_counts_cjk_double():
    assert x_weighted_length("abc") == 3
    assert x_weighted_length("你好") == 4


def test_bluesky_facets_use_byte_offsets():
    text = "新品 #opc 见 https://a.io"
    facets = BlueskyRoute.facets(text)
    raw = text.encode()
    assert [raw[f["index"]["byteStart"]:f["index"]["byteEnd"]].decode() for f in facets] == ["#opc", "https://a.io"]
    assert facets[0]["features"][0]["tag"] == "opc"


def test_data_service_key_lives_in_keychain(tmp_path, memory_keyring):
    social = SocialService(tmp_path / "home", tmp_path)
    assert social.services()[0]["configured"] is False
    listed = asyncio.run(social.configure_service("twitterapi", {"api_key": "k-123"}))
    assert listed[0]["configured"] is True and listed[0]["source"] == "keychain"
    assert ("AIOPC", "service:twitterapi") in memory_keyring.store
    # X reads now go through the third-party route.
    _, _, account = make(tmp_path)
    assert social.describe(AccountStore(tmp_path / "home").get(account["id"]))["routes"][0]["id"] == "x-data"
    asyncio.run(social.configure_service("twitterapi", {}))
    assert social.services()[0]["configured"] is False


def test_routes_endpoints(tmp_path, monkeypatch):
    from starlette.testclient import TestClient

    from aiopc.server import create_api

    async def verify(self, handle, app_password):
        return {"did": "did:plc:x", "handle": "me.bsky.social"}

    monkeypatch.setattr(routes.BlueskyRoute, "verify", verify)
    account = AccountStore(tmp_path / "home").upsert("bluesky", {"id": "b", "name": "me"})
    api = TestClient(create_api(tmp_path / "home", "t"))
    params, headers = {"workspace": str(tmp_path)}, {"Authorization": "Bearer t"}
    added = api.post(f"/api/accounts/{account['id']}/routes", params=params, headers=headers,
                     json={"route": "bluesky-api", "fields": {"handle": "me", "app_password": "abcd-efgh"}}).json()
    assert added["publish"] == "compose" and any(item["attached"] for item in added["enhancements"])
    removed = api.delete(f"/api/accounts/{account['id']}/routes/bluesky-api", params=params, headers=headers).json()
    assert removed["publish"] == "compose"
    services = api.get("/api/integrations", params=params, headers=headers).json()["services"]
    assert services[0]["id"] == "twitterapi"


def test_connect_with_official_api_alone(tmp_path, monkeypatch):
    async def verify(self, keys):
        return {"id": "77", "username": "opc_lab", "name": "OPC Lab"}

    monkeypatch.setattr(routes.XApiRoute, "verify", verify)
    social = SocialService(tmp_path / "home", tmp_path)
    keys = {"api_key": "a", "api_secret": "b", "access_token": "c", "access_token_secret": "d"}
    connected = asyncio.run(social.connect_with_route("X", "x-api", keys))
    account = connected["account"]
    assert account["handle"] == "opc_lab" and account["publish"] == "compose"
    assert account["services"][0]["id"] == "twitterapi"
    with pytest.raises(SocialError, match="四项"):
        asyncio.run(social.connect_with_route("x", "x-api", {"api_key": "a"}))
