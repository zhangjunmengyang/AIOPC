import asyncio
import json

import pytest
from PIL import Image

from aiopc.accounts import AccountStore
from aiopc.server import create_server
from aiopc.social.review import RESOURCE, PublishReview
from aiopc.social.service import SocialError, SocialService

ACTION = {"approved": True, "resourceUri": RESOURCE}


class Browser:
    def __init__(self):
        self.calls = []

    async def account(self, platform):
        return {"id": "1", "name": "测试号"}

    async def compose(self, platform, form, **payload):
        self.calls.append(payload)
        return {"page_url": "https://creator.xiaohongshu.com/publish/publish"}


def setup(tmp_path):
    browser = Browser()
    social = SocialService(tmp_path / "home", tmp_path, browser=browser)
    account = AccountStore(tmp_path / "home").upsert("xhs", {"id": "1", "name": "测试号"}, project=str(tmp_path))
    image = tmp_path / "封面.png"
    Image.new("RGB", (40, 40), "red").save(image)
    reviews = PublishReview(social)
    draft = reviews.prepare(account["id"], "需要人工确认的正文", "测试标题", [str(image)])
    return browser, reviews, draft, image


def test_prepare_only_and_app_approval_required(tmp_path):
    browser, reviews, draft, _ = setup(tmp_path)
    assert not browser.calls
    for action in (None, {"approved": False, "resourceUri": RESOURCE}, {"approved": True, "resourceUri": "ui://other"}):
        with pytest.raises(SocialError, match="AI 不能代为审批"):
            asyncio.run(reviews.decide(draft["id"], draft["digest"], "approve", app_action=action))
    result = asyncio.run(reviews.decide(draft["id"], draft["digest"], "approve", app_action=ACTION))
    assert result["status"] == "composer_filled"
    assert browser.calls[0]["title"] == "测试标题"
    # Replayed button clicks never fill a second tab.
    assert asyncio.run(reviews.decide(draft["id"], draft["digest"], "approve", app_action=ACTION)) == result
    assert len(browser.calls) == 1


def test_reject_blocks_fill(tmp_path):
    browser, reviews, draft, _ = setup(tmp_path)
    result = asyncio.run(reviews.decide(draft["id"], draft["digest"], "reject", app_action=ACTION))
    assert result["status"] == "rejected" and not browser.calls
    with pytest.raises(SocialError, match="已处理"):
        asyncio.run(reviews.decide(draft["id"], draft["digest"], "approve", app_action=ACTION))


def test_changed_media_requires_new_review(tmp_path):
    browser, reviews, draft, image = setup(tmp_path)
    Image.new("RGB", (40, 40), "blue").save(image)
    with pytest.raises(SocialError, match="媒体文件已变更"):
        asyncio.run(reviews.decide(draft["id"], draft["digest"], "approve", app_action=ACTION))
    assert not browser.calls


def test_changed_copy_requires_new_review(tmp_path):
    browser, reviews, draft, _ = setup(tmp_path)
    path = reviews._path(draft["id"])
    changed = json.loads(path.read_text())
    changed["payload"]["text"] = "审批以后换了正文"
    path.write_text(json.dumps(changed))
    with pytest.raises(SocialError, match="稿件已变更"):
        asyncio.run(reviews.decide(draft["id"], draft["digest"], "approve", app_action=ACTION))
    assert not browser.calls


def test_cross_project_account_rejected(tmp_path):
    social = SocialService(tmp_path / "home", tmp_path)
    account = AccountStore(tmp_path / "home").upsert("x", {"id": "1", "name": "其他项目"}, project="/other")
    with pytest.raises(SocialError, match="不属于当前项目"):
        PublishReview(social).prepare(account["id"], "hi")


def test_mcp_card_schema_and_thumbnail(tmp_path):
    _, reviews, draft, _ = setup(tmp_path)
    server = create_server(tmp_path / "home", tmp_path)
    tools = {tool.name: tool for tool in asyncio.run(server.list_tools())}
    assert tools["social_publish"].meta["ui"]["resourceUri"] == RESOURCE
    confirm = tools["social_confirm_publish"]
    assert confirm.meta["ui"]["visibility"] == ["app"]
    assert "ctx" not in confirm.inputSchema["properties"]
    media = reviews.preview_media(draft)
    assert media[0]["name"] == "封面.png"
    assert media[0]["preview"].startswith("data:image/jpeg;base64,")
    resources = asyncio.run(server.list_resources())
    assert any(str(resource.uri) == RESOURCE and resource.mimeType == "text/html;profile=mcp-app" for resource in resources)


def test_switched_browser_account_blocks_fill(tmp_path):
    browser, reviews, draft, _ = setup(tmp_path)

    async def other_account(platform):
        return {"id": "another-person"}

    browser.account = other_account
    with pytest.raises(SocialError, match="当前登录的账号"):
        asyncio.run(reviews.decide(draft["id"], draft["digest"], "approve", app_action=ACTION))
    assert not browser.calls


def test_fill_uses_frozen_media_even_if_original_changes_during_identity_check(tmp_path):
    browser, reviews, draft, image = setup(tmp_path)
    original = image.read_bytes()

    async def change_during_await(platform):
        Image.new("RGB", (40, 40), "green").save(image)
        return {"id": "1"}

    browser.account = change_during_await
    asyncio.run(reviews.decide(draft["id"], draft["digest"], "approve", app_action=ACTION))
    uploaded = browser.calls[0]["media"][0]
    assert uploaded != image
    assert uploaded.read_bytes() == original
