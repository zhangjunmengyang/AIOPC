"""Read-only X data from a third-party aggregator, cached locally to save cost.

These providers serve data they collected from X; results can lag the live
site by minutes and are far cheaper than the official read API. Posting stays
on official routes (Buffer / X API) behind the approval gate.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Literal, Protocol

import httpx

USERNAME = re.compile(r"^@?([A-Za-z0-9_]{1,15})$")
TWEET_ID = re.compile(r"^\d{1,25}$")
MAX_PAGES = 5
# Seconds a cached page stays fresh, by kind of data.
TTL = {"search": 15 * 60, "user": 6 * 3600, "timeline": 15 * 60, "mentions": 10 * 60, "replies": 10 * 60, "tweets": 3600}
# twitterapi.io list prices (USD), used only for the local spend estimate.
PRICE_PER_TWEET = 0.15 / 1000
PRICE_PER_USER = 0.18 / 1000
MIN_PER_REQUEST = 0.00015


class XDataError(ValueError):
    pass


class Provider(Protocol):
    name: str

    def get(self, path: str, params: dict[str, Any]) -> dict[str, Any]: ...


class TwitterApiIo:
    name = "twitterapi.io"
    base = "https://api.twitterapi.io"

    def __init__(self, api_key: str, client: httpx.Client | None = None):
        if not api_key:
            raise XDataError("X 第三方数据未配置：在「账号 → 接口与数据」里填写 twitterapi.io 的 API Key。")
        self.api_key = api_key
        self.client = client or httpx.Client(timeout=30)

    def get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        try:
            response = self.client.get(self.base + path, params={k: v for k, v in params.items() if v not in (None, "")},
                                       headers={"X-API-Key": self.api_key})
        except httpx.HTTPError as exc:
            raise XDataError(f"{self.name} 暂时无法访问（{type(exc).__name__}），稍后重试。") from None
        if response.status_code in {401, 403}:
            raise XDataError(f"{self.name} 拒绝了 API Key，检查 TWITTERAPI_IO_KEY 和账户余额。")
        if response.status_code == 429:
            raise XDataError(f"{self.name} 限流，稍后重试。")
        try:
            data = response.json()
        except ValueError:
            raise XDataError(f"{self.name} 返回了无法解析的内容（HTTP {response.status_code}）。") from None
        if response.status_code >= 400 or (isinstance(data, dict) and data.get("status") == "error"):
            message = data.get("msg") or data.get("message") if isinstance(data, dict) else ""
            raise XDataError(f"{self.name} 请求失败（HTTP {response.status_code}）：{str(message)[:300]}")
        if not isinstance(data, dict):
            raise XDataError(f"{self.name} 返回格式异常。")
        return data


def _metric(value: Any) -> int | None:
    return value if isinstance(value, int) else None


def compact_user(user: Any) -> dict[str, Any] | None:
    if not isinstance(user, dict):
        return None
    return {key: user.get(source) for key, source in (
        ("username", "userName"), ("name", "name"), ("id", "id"), ("description", "description"),
        ("followers", "followers"), ("following", "following"), ("posts", "statusesCount"),
        ("verified", "isBlueVerified"), ("location", "location"), ("created_at", "createdAt"), ("url", "url"),
    ) if user.get(source) not in (None, "")}


def compact_tweet(tweet: Any) -> dict[str, Any] | None:
    if not isinstance(tweet, dict) or not tweet.get("id"):
        return None
    author = compact_user(tweet.get("author")) or {}
    result: dict[str, Any] = {
        "id": str(tweet["id"]), "url": tweet.get("url"), "text": tweet.get("text", ""),
        "created_at": tweet.get("createdAt"), "lang": tweet.get("lang"),
        "author": {key: author[key] for key in ("username", "name", "followers", "verified") if key in author},
        "metrics": {name: _metric(tweet.get(source)) for name, source in (
            ("likes", "likeCount"), ("replies", "replyCount"), ("reposts", "retweetCount"),
            ("quotes", "quoteCount"), ("views", "viewCount"), ("bookmarks", "bookmarkCount"))
            if _metric(tweet.get(source)) is not None},
    }
    if tweet.get("isReply"):
        result["in_reply_to"] = {"id": tweet.get("inReplyToId"), "username": tweet.get("inReplyToUsername")}
    if tweet.get("conversationId"):
        result["conversation_id"] = str(tweet["conversationId"])
    for key, source in (("quoted", "quoted_tweet"), ("reposted", "retweeted_tweet")):
        inner = tweet.get(source)
        if isinstance(inner, dict) and inner.get("id"):
            result[key] = {"id": str(inner["id"]), "text": inner.get("text", ""), "author": (compact_user(inner.get("author")) or {}).get("username")}
    return result


class XDataService:
    def __init__(self, instance: Path, provider: Provider | None = None):
        self.root = Path(instance) / "xdata"
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = self.root / "cache.sqlite3"
        self._provider = provider
        with self._connect() as db:
            db.executescript("""
            CREATE TABLE IF NOT EXISTS pages (key TEXT PRIMARY KEY, kind TEXT NOT NULL, fetched_at REAL NOT NULL, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, at REAL NOT NULL, provider TEXT NOT NULL,
                kind TEXT NOT NULL, tweets INTEGER NOT NULL, users INTEGER NOT NULL, cost REAL NOT NULL);
            """)

    @property
    def provider(self) -> Provider:
        if self._provider is None:
            # Set on the Accounts page (Keychain), or TWITTERAPI_IO_KEY in ~/.aiopc/.env.
            from aiopc import credentials

            stored = credentials.load("service", "twitterapi") or {}
            self._provider = TwitterApiIo(stored.get("api_key") or os.environ.get("TWITTERAPI_IO_KEY", "").strip())
        return self._provider

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.db, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        try:
            with db:
                yield db
        finally:
            db.close()

    def _page(self, kind: str, path: str, params: dict[str, Any], *, fresh: bool) -> tuple[dict[str, Any], bool]:
        key = hashlib.sha256(json.dumps([self.provider.name, path, params], sort_keys=True).encode()).hexdigest()
        if not fresh:
            with self._connect() as db:
                row = db.execute("SELECT * FROM pages WHERE key=?", (key,)).fetchone()
            if row is not None and time.time() - row["fetched_at"] < TTL[kind]:
                return json.loads(row["body"]), True
        data = self.provider.get(path, params)
        nested = data.get("data") if isinstance(data.get("data"), dict) else {}
        listed = data.get("tweets") if isinstance(data.get("tweets"), list) else nested.get("tweets")
        tweets = len(listed) if isinstance(listed, list) else 0
        users = 1 if kind == "user" else 0
        cost = max(MIN_PER_REQUEST, tweets * PRICE_PER_TWEET + users * PRICE_PER_USER)
        with self._connect() as db:
            db.execute("INSERT OR REPLACE INTO pages (key, kind, fetched_at, body) VALUES (?,?,?,?)",
                       (key, kind, time.time(), json.dumps(data, ensure_ascii=False)))
            db.execute("INSERT INTO usage (at, provider, kind, tweets, users, cost) VALUES (?,?,?,?,?,?)",
                       (time.time(), self.provider.name, kind, tweets, users, cost))
        return data, False

    def _tweets(self, kind: str, path: str, params: dict[str, Any], pages: int, fresh: bool) -> dict[str, Any]:
        if not isinstance(pages, int) or not 1 <= pages <= MAX_PAGES:
            raise XDataError(f"pages 取 1–{MAX_PAGES}；每页约 20 条，按条计费。")
        collected: list[dict[str, Any]] = []
        cursor, cached_pages, has_next = "", 0, False
        for _ in range(pages):
            data, cached = self._page(kind, path, {**params, "cursor": cursor}, fresh=fresh)
            cached_pages += cached
            # Timelines nest tweets under "data" but keep the cursor at the top level.
            nested = data.get("data") if isinstance(data.get("data"), dict) else {}
            tweets = data.get("tweets") if isinstance(data.get("tweets"), list) else nested.get("tweets") or []
            collected.extend(item for item in (compact_tweet(tweet) for tweet in tweets) if item)
            next_cursor = data.get("next_cursor") or nested.get("next_cursor")
            has_next = bool((data.get("has_next_page") or nested.get("has_next_page")) and next_cursor)
            if not has_next:
                break
            cursor = next_cursor
        seen, unique = set(), []
        for tweet in collected:
            if tweet["id"] not in seen:
                seen.add(tweet["id"])
                unique.append(tweet)
        return {"source": self.provider.name, "count": len(unique), "tweets": unique, "has_more": has_next,
                "cached_pages": cached_pages,
                "note": "Third-party data; may lag x.com by minutes and omit protected or deleted posts."}

    @staticmethod
    def _username(value: str) -> str:
        match = USERNAME.match(value.strip()) if isinstance(value, str) else None
        if match is None:
            raise XDataError("用户名格式不正确（1–15 位字母、数字或下划线，可带 @）。")
        return match[1]

    # ── tools ────────────────────────────────────────────────────────────
    def search(self, query: str, sort: Literal["Latest", "Top"] = "Latest", pages: int = 1, fresh: bool = False) -> dict[str, Any]:
        """Advanced search syntax works: from:user, "exact phrase", lang:zh, min_faves:50, since:2026-11-01, -filter:replies."""
        if not isinstance(query, str) or not query.strip() or len(query) > 512:
            raise XDataError("query 不能为空，且不超过 512 字符。")
        if sort not in {"Latest", "Top"}:
            raise XDataError("sort 取 Latest 或 Top。")
        return self._tweets("search", "/twitter/tweet/advanced_search", {"query": query.strip(), "queryType": sort}, pages, fresh)

    def user(self, username: str, fresh: bool = False) -> dict[str, Any]:
        data, cached = self._page("user", "/twitter/user/info", {"userName": self._username(username)}, fresh=fresh)
        user = compact_user(data.get("data"))
        if not user:
            raise XDataError("没有找到这个账号，或账号已停用。")
        return {"source": self.provider.name, "user": user, "cached": cached}

    def user_posts(self, username: str, pages: int = 1, include_replies: bool = False, fresh: bool = False) -> dict[str, Any]:
        return self._tweets("timeline", "/twitter/user/last_tweets",
                            {"userName": self._username(username), "includeReplies": "true" if include_replies else "false"}, pages, fresh)

    def mentions(self, username: str, pages: int = 1, fresh: bool = False) -> dict[str, Any]:
        return self._tweets("mentions", "/twitter/user/mentions", {"userName": self._username(username)}, pages, fresh)

    def replies(self, tweet_id: str, pages: int = 1, fresh: bool = False) -> dict[str, Any]:
        if not isinstance(tweet_id, str) or not TWEET_ID.match(tweet_id):
            tweet_id = str(tweet_id).rstrip("/").rsplit("/", 1)[-1].split("?", 1)[0]
            if not TWEET_ID.match(tweet_id):
                raise XDataError("tweet_id 应为帖子数字 ID 或帖子链接。")
        return self._tweets("replies", "/twitter/tweet/replies", {"tweetId": tweet_id}, pages, fresh)

    def posts(self, tweet_ids: list[str], fresh: bool = False) -> dict[str, Any]:
        ids = [str(item).strip() for item in tweet_ids] if isinstance(tweet_ids, list) else []
        if not 1 <= len(ids) <= 50 or not all(TWEET_ID.match(item) for item in ids):
            raise XDataError("tweet_ids 需要 1–50 个数字 ID。")
        data, cached = self._page("tweets", "/twitter/tweets", {"tweet_ids": ",".join(ids)}, fresh=fresh)
        tweets = [item for item in (compact_tweet(tweet) for tweet in data.get("tweets") or []) if item]
        return {"source": self.provider.name, "count": len(tweets), "tweets": tweets, "cached": cached}

    def usage(self, days: int = 30) -> dict[str, Any]:
        since = time.time() - max(1, min(days, 365)) * 86400
        with self._connect() as db:
            rows = db.execute("SELECT kind, COUNT(*) AS requests, SUM(tweets) AS tweets, SUM(users) AS users, SUM(cost) AS cost"
                              " FROM usage WHERE at>=? GROUP BY kind", (since,)).fetchall()
        by_kind = [dict(row) for row in rows]
        return {"days": days, "by_kind": by_kind,
                "estimated_usd": round(sum(row["cost"] or 0 for row in by_kind), 4),
                "note": "Local estimate from list prices; the provider dashboard is authoritative."}
