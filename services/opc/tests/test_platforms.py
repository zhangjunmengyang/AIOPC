import asyncio

import pytest

from aiopc.accounts import AccountError, normalize_platform
from aiopc.platforms import BY_ID, CATALOG, catalog
from aiopc.social.service import SocialService


def test_catalog_is_grouped_and_unique():
    ids = [platform.id for platform in CATALOG]
    assert len(ids) == len(set(ids))
    regions = {item["region"] for item in catalog()}
    assert regions == {"cn", "global"}
    assert BY_ID["xhs"].fills_composer and not BY_ID["producthunt"].fills_composer


@pytest.mark.parametrize("value, expected", [("小红书", "xhs"), ("Twitter", "x"), ("哔哩哔哩", "bilibili"), ("dev.to", "devto"), ("公众号", "wechat")])
def test_aliases(value, expected):
    assert normalize_platform(value) == expected


def test_unknown_platform():
    with pytest.raises(AccountError):
        normalize_platform("myspace")


def test_every_platform_connects_in_the_browser(tmp_path, monkeypatch):
    from aiopc.social import service

    opened = []

    class FakeBrowser:
        async def open_login(self, platform, screenshot=True):
            opened.append(platform)
            return {"tab_id": "t1"}

        async def account(self, platform):
            return None

    monkeypatch.setattr(service, "OpenWorkBrowser", FakeBrowser)
    social = SocialService(tmp_path / "home", tmp_path)
    opened_login = asyncio.run(social.connect("Product Hunt"))
    assert opened_login["status"] == "login_opened" and opened_login["engine"] == "embedded"
    # No detector for Product Hunt: the person's "I've logged in" saves the browser's account.
    saved = asyncio.run(social.connect("producthunt", check=True))
    assert saved["status"] == "connected" and saved["account"]["publish"] == "browser"
    assert saved["account"]["engine"] == "embedded"
    assert opened == ["producthunt"]


def test_github_connects_through_gh_authorization(tmp_path, monkeypatch):
    from aiopc.social import service

    opened = []

    class FakeBrowser:
        async def open_device_authorization(self, url, code):
            opened.append((url, code))

    class FakeAuth:
        logged_in = None

        async def user(self):
            return self.logged_in

        async def start(self):
            return {"code": "ABCD-1234", "url": "https://github.com/login/device"}

        def state(self):
            return "waiting"

        error = ""

    auth = FakeAuth()
    monkeypatch.setattr(service, "OpenWorkBrowser", FakeBrowser)
    monkeypatch.setattr(service, "github_auth", lambda home: auth)
    social = SocialService(tmp_path / "home", tmp_path)

    started = asyncio.run(social.connect("GitHub"))
    assert started["status"] == "authorize" and started["code"] == "ABCD-1234"
    assert opened == [("https://github.com/login/device", "ABCD-1234")]
    assert asyncio.run(social.connect("github", check=True))["status"] == "not_logged_in"

    auth.logged_in = {"id": "42", "name": "Mona", "handle": "octocat", "url": "https://github.com/octocat"}
    saved = asyncio.run(social.connect("github", check=True))
    assert saved["status"] == "connected" and saved["account"]["handle"] == "octocat"
