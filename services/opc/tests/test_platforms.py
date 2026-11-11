import asyncio

import pytest

from aiopc.accounts import AccountError, normalize_platform
from aiopc.platforms import BY_ID, CATALOG, catalog
from aiopc.social.service import SocialError, SocialService


def test_catalog_is_grouped_and_unique():
    ids = [platform.id for platform in CATALOG]
    assert len(ids) == len(set(ids))
    regions = {item["region"] for item in catalog()}
    assert regions == {"cn", "global"}
    assert BY_ID["xhs"].available and not BY_ID["producthunt"].available


@pytest.mark.parametrize("value, expected", [("小红书", "xhs"), ("Twitter", "x"), ("哔哩哔哩", "bilibili"), ("dev.to", "devto"), ("公众号", "wechat")])
def test_aliases(value, expected):
    assert normalize_platform(value) == expected


def test_unknown_platform():
    with pytest.raises(AccountError):
        normalize_platform("myspace")


def test_planned_platforms_cannot_connect(tmp_path):
    social = SocialService(tmp_path / "home", tmp_path)
    with pytest.raises(SocialError, match="即将支持"):
        asyncio.run(social.connect("Product Hunt"))
