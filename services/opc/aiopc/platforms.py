"""Every platform AIOPC knows: one catalog for the Accounts page, the AI's tools and the account store.

Connecting any platform means logging in once in AIOPC's built-in browser; the login
stays saved and the AI can work on that site in the browser. Where MultiPost
(Apache-2.0) knows the platform's composer, the AI can also fill a post for the person
to publish (``forms``). Regions group the picker: 国内 and 出海.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

Region = Literal["cn", "global"]
REGIONS: dict[str, str] = {"cn": "国内", "global": "出海"}
CATEGORIES: dict[str, str] = {
    "social": "社交媒体", "video": "视频", "longform": "长文与资讯", "community": "社区与开发者",
    "finance": "财经消费", "newsletter": "博客与订阅",
}


@dataclass(frozen=True)
class Platform:
    id: str
    name: str
    region: Region
    category: str
    login: str
    # Our forms (post / article / video) → MultiPost platform keys. Empty: the AI works in the browser directly.
    forms: dict[str, str] = field(default_factory=dict)
    aliases: tuple[str, ...] = ()
    color: str = ""

    @property
    def fills_composer(self) -> bool:
        return bool(self.forms)

    def describe(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "region": self.region, "region_name": REGIONS[self.region],
                "category": self.category, "category_name": CATEGORIES[self.category], "forms": list(self.forms),
                "fills_composer": self.fills_composer, "login_url": self.login, "color": self.color}


CATALOG: tuple[Platform, ...] = (
    # ── 国内 ──
    Platform("xhs", "小红书", "cn", "social", "https://creator.xiaohongshu.com/login",
             {"post": "DYNAMIC_REDNOTE", "video": "VIDEO_REDNOTE"}, ("xiaohongshu", "rednote"), "#FF2442"),
    Platform("weibo", "微博", "cn", "social", "https://weibo.com/login.php",
             {"post": "DYNAMIC_WEIBO", "article": "ARTICLE_WEIBO", "video": "VIDEO_WEIBO"}, ("新浪微博",), "#E6162D"),
    Platform("jike", "即刻", "cn", "social", "https://web.okjike.com/login",
             {"post": "DYNAMIC_OKJIKE", "video": "VIDEO_OKJIKE"}, ("okjike",), "#FFE411"),
    Platform("douban", "豆瓣", "cn", "social", "https://accounts.douban.com/passport/login",
             {"post": "DYNAMIC_DOUBAN", "article": "ARTICLE_DOUBAN"}, (), "#2D963D"),
    Platform("douyin", "抖音", "cn", "video", "https://creator.douyin.com",
             {"post": "DYNAMIC_DOUYIN", "video": "VIDEO_DOUYIN"}, (), "#000000"),
    Platform("channels", "视频号", "cn", "video", "https://channels.weixin.qq.com/login.html",
             {"post": "DYNAMIC_WEIXINCHANNEL", "video": "VIDEO_WEIXINCHANNEL"}, ("微信视频号",), "#FA9D3B"),
    Platform("bilibili", "B站", "cn", "video", "https://passport.bilibili.com/login",
             {"post": "DYNAMIC_BILIBILI", "article": "ARTICLE_BILIBILI", "video": "VIDEO_BILIBILI"}, ("哔哩哔哩", "bilibili"), "#00A1D6"),
    Platform("kuaishou", "快手", "cn", "video", "https://cp.kuaishou.com", {"post": "DYNAMIC_KUAISHOU", "video": "VIDEO_KUAISHOU"}, (), "#FF4906"),
    Platform("xiaoheihe", "小黑盒", "cn", "video", "https://www.xiaoheihe.cn/",
             {"post": "DYNAMIC_XIAOHEIHE", "video": "VIDEO_XIAOHEIHE"}, (), "#1F1F1F"),
    Platform("wechat", "公众号", "cn", "longform", "https://mp.weixin.qq.com/",
             {"article": "ARTICLE_WEIXIN", "post": "DYNAMIC_WEIXIN"}, ("微信公众号", "微信公众平台"), "#07C160"),
    Platform("zhihu", "知乎", "cn", "longform", "https://www.zhihu.com/signin",
             {"post": "DYNAMIC_ZHIHU", "article": "ARTICLE_ZHIHU", "video": "VIDEO_ZHIHU"}, (), "#0084FF"),
    Platform("toutiao", "头条号", "cn", "longform", "https://mp.toutiao.com/",
             {"post": "DYNAMIC_TOUTIAOHAO", "article": "ARTICLE_TOUTIAO", "video": "VIDEO_TOUTIAOHAO"}, ("头条", "今日头条"), "#F04142"),
    Platform("baijiahao", "百家号", "cn", "longform", "https://baijiahao.baidu.com/",
             {"post": "DYNAMIC_BAIJIAHAO", "article": "ARTICLE_BAIJIAHAO", "video": "VIDEO_BAIJIAHAO"}, ("百度百家号",), "#2932E1"),
    Platform("netease", "网易号", "cn", "longform", "https://mp.163.com/", {"article": "ARTICLE_NETEASE", "video": "VIDEO_NETEASE"}, (), "#E60026"),
    Platform("sohu", "搜狐号", "cn", "longform", "https://mp.sohu.com/", {"article": "ARTICLE_SOHU", "video": "VIDEO_SOHU"}, (), "#FFD100"),
    Platform("jianshu", "简书", "cn", "longform", "https://www.jianshu.com/sign_in", {"article": "ARTICLE_JIANSHU"}, (), "#EA6F5A"),
    Platform("juejin", "掘金", "cn", "community", "https://juejin.cn/login",
             {"post": "DYNAMIC_JUEJIN", "article": "ARTICLE_JUEJIN"}, (), "#007FFF"),
    Platform("csdn", "CSDN", "cn", "community", "https://passport.csdn.net/login", {"article": "ARTICLE_CSDN"}, (), "#FC5531"),
    Platform("sspai", "少数派", "cn", "community", "https://sspai.com/", {"article": "ARTICLE_SSPAI"}, (), "#D71A1B"),
    Platform("woshipm", "人人都是产品经理", "cn", "community", "https://www.woshipm.com/", {"article": "ARTICLE_WOSHIPM"}, ("woshipm",), "#0EB8A6"),
    Platform("v2ex", "V2EX", "cn", "community", "https://www.v2ex.com/signin", {"post": "DYNAMIC_V2EX"}, (), "#1F1F1F"),
    Platform("segmentfault", "思否", "cn", "community", "https://segmentfault.com/user/login", {"article": "ARTICLE_SEGMENTFAULT"}, ("segmentfault",), "#009A61"),
    Platform("zsxq", "知识星球", "cn", "community", "https://wx.zsxq.com/", {"post": "DYNAMIC_ZSXQ", "article": "ARTICLE_ZSXQ"}, (), "#16B998"),
    Platform("xueqiu", "雪球", "cn", "finance", "https://xueqiu.com", {"post": "DYNAMIC_XUEQIU", "article": "ARTICLE_XUEQIU"}, (), "#1F87F0"),
    Platform("smzdm", "什么值得买", "cn", "finance", "https://www.smzdm.com/", {"article": "ARTICLE_SMZDM"}, ("值得买",), "#E62828"),
    # ── 出海 ──
    Platform("x", "X", "global", "social", "https://x.com/i/flow/login",
             {"post": "DYNAMIC_X", "article": "ARTICLE_XARTICLE"}, ("twitter", "推特"), "#000000"),
    Platform("linkedin", "LinkedIn", "global", "social", "https://www.linkedin.com/login", {"post": "DYNAMIC_LINKEDIN"}, ("领英",), "#0A66C2"),
    Platform("threads", "Threads", "global", "social", "https://www.threads.net/login", {"post": "DYNAMIC_THREADS"}, (), "#000000"),
    Platform("bluesky", "Bluesky", "global", "social", "https://bsky.app/", {"post": "DYNAMIC_BLUESKY", "video": "VIDEO_BLUESKY"}, (), "#0285FF"),
    Platform("instagram", "Instagram", "global", "social", "https://www.instagram.com/", {"post": "DYNAMIC_INSTAGRAM"}, ("ins",), "#FF0069"),
    Platform("facebook", "Facebook", "global", "social", "https://www.facebook.com/", {"post": "DYNAMIC_FACEBOOK"}, (), "#0866FF"),
    Platform("pinterest", "Pinterest", "global", "social", "https://www.pinterest.com/", {"post": "DYNAMIC_PINTEREST"}, (), "#BD081C"),
    Platform("reddit", "Reddit", "global", "community", "https://www.reddit.com/login/", {"post": "DYNAMIC_REDDIT"}, (), "#FF4500"),
    Platform("youtube", "YouTube", "global", "video", "https://studio.youtube.com/", {"video": "VIDEO_YOUTUBE"}, ("油管",), "#FF0000"),
    Platform("tiktok", "TikTok", "global", "video", "https://www.tiktok.com/login", {"video": "VIDEO_TIKTOK"}, (), "#000000"),
    Platform("medium", "Medium", "global", "newsletter", "https://medium.com/", {"article": "ARTICLE_MEDIUM"}, (), "#000000"),
    Platform("substack", "Substack", "global", "newsletter", "https://substack.com/sign-in",
             {"post": "DYNAMIC_SUBSTACK", "article": "ARTICLE_SUBSTACK"}, (), "#FF6719"),
    Platform("wordpress", "WordPress.com", "global", "newsletter", "https://wordpress.com/log-in", {"article": "ARTICLE_WORDPRESS"}, ("wordpress",), "#21759B"),
    # Communities and tools: the AI works on these sites in the browser.
    Platform("producthunt", "Product Hunt", "global", "community", "https://www.producthunt.com/", color="#DA552F"),
    Platform("hackernews", "Hacker News", "global", "community", "https://news.ycombinator.com/login", aliases=("hn",), color="#F0652F"),
    Platform("indiehackers", "Indie Hackers", "global", "community", "https://www.indiehackers.com/", color="#0E2439"),
    Platform("devto", "DEV", "global", "community", "https://dev.to/enter", aliases=("dev.to",), color="#0A0A0A"),
    Platform("mastodon", "Mastodon", "global", "social", "https://joinmastodon.org/", color="#6364FF"),
    Platform("discord", "Discord", "global", "community", "https://discord.com/login", color="#5865F2"),
    Platform("telegram", "Telegram", "global", "community", "https://web.telegram.org/", color="#26A5E4"),
    Platform("github", "GitHub", "global", "community", "https://github.com/login", color="#181717"),
    Platform("huggingface", "Hugging Face", "global", "community", "https://huggingface.co/login", color="#FFD21E"),
)

BY_ID: dict[str, Platform] = {platform.id: platform for platform in CATALOG}
PLATFORMS: dict[str, str] = {platform.id: platform.name for platform in CATALOG}
MULTIPOST_KEYS: dict[str, dict[str, str]] = {platform.id: dict(platform.forms) for platform in CATALOG if platform.fills_composer}
LOGIN_PAGES: dict[str, str] = {platform.id: platform.login for platform in CATALOG}
ALIASES: dict[str, str] = {
    alias.casefold(): platform.id
    for platform in CATALOG
    for alias in (platform.id, platform.name, *platform.aliases)
}


def catalog() -> list[dict[str, Any]]:
    return [platform.describe() for platform in CATALOG]
