#!/bin/sh
# Bundle MultiPost's per-platform composer scripts (Apache-2.0) for injection into a
# logged-in tab. We reuse their maintained selectors instead of writing our own.
# Usage: build.sh <MultiPost-Extension checkout>   (pinned commit recorded in dist/SOURCE)
set -eu
SRC=$(cd "$1" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/shim.js" <<'JS'
// The platform tables call chrome.i18n for display names; nothing else from the extension runs.
globalThis.chrome = globalThis.chrome || {};
if (!globalThis.chrome.i18n) globalThis.chrome.i18n = { getMessage: (key) => key };
JS
cat > "$WORK/entry.js" <<JS
import "./shim.js";
import { DynamicInfoMap } from "$SRC/src/sync/dynamic.ts";
import { ArticleInfoMap } from "$SRC/src/sync/article.ts";
import { VideoInfoMap } from "$SRC/src/sync/video.ts";
import { getXAccountInfo } from "$SRC/src/sync/account/x.ts";
import { getRednoteAccountInfo } from "$SRC/src/sync/account/rednote.ts";
import { getDouyinAccountInfo } from "$SRC/src/sync/account/douyin.ts";
import { getBilibiliAccountInfo } from "$SRC/src/sync/account/bilibili.ts";
import { getTiktokAccountInfo } from "$SRC/src/sync/account/tiktok.ts";
const all = { ...DynamicInfoMap, ...ArticleInfoMap, ...VideoInfoMap };
// Who is logged in, run on the platform's own origin. Zhihu is ours (MultiPost has none).
async function getZhihuAccountInfo() {
  const response = await fetch("https://www.zhihu.com/api/v4/me", { credentials: "include" });
  if (!response.ok) throw new Error("not logged in");
  const me = await response.json();
  return { provider: "zhihu", accountId: String(me.id), username: me.name, profileUrl: "https://www.zhihu.com/people/" + me.url_token, extraData: { handle: me.url_token } };
}
const accounts = { x: getXAccountInfo, xhs: getRednoteAccountInfo, douyin: getDouyinAccountInfo,
  bilibili: getBilibiliAccountInfo, tiktok: getTiktokAccountInfo, zhihu: getZhihuAccountInfo };
globalThis.__opcMultiPost = {
  platforms: Object.fromEntries(Object.entries(all).map(([key, info]) => [key, {
    type: info.type, homeUrl: info.homeUrl, injectUrl: info.injectUrl, accountKey: info.accountKey, tags: info.tags || [] }])),
  // Fill the composer; publishing stays with the person, whatever the caller passes.
  // files: { name: { b64, type } } served to the scripts as opc-file:<name>, so local
  // media reaches the page without fetching from another origin (page CSP stays intact).
  async run(key, data, files) {
    const info = all[key];
    if (!info) throw new Error("Unknown MultiPost platform " + key);
    const pageFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input && input.url;
      if (url && url.startsWith("opc-file:")) {
        const file = (files || {})[url.slice(9)];
        if (!file) return Promise.reject(new Error("missing " + url));
        const bytes = Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0));
        return Promise.resolve(new Response(new Blob([bytes], { type: file.type }), { status: 200 }));
      }
      return pageFetch.call(globalThis, input, init);
    };
    try {
      await info.injectFunction({ platforms: [{ name: key }], isAutoPublish: false, data });
    } finally {
      globalThis.fetch = pageFetch;
    }
    return { ok: true, platform: key };
  },
  async account(platform) {
    const getter = accounts[platform];
    if (!getter) return null;
    try { return await getter(); } catch (error) { return { error: String(error && error.message || error) }; }
  },
};
JS
npx -y esbuild@0.24.2 "$WORK/entry.js" --bundle --format=iife --platform=browser --target=es2020 \
  --alias:~sync="$SRC/src/sync" --alias:~=$SRC/src --log-level=warning --outfile="$HERE/dist/multipost.js"
node -e "
const fs=require('fs');globalThis.window=globalThis;globalThis.document={};
require('$HERE/dist/multipost.js');
fs.writeFileSync('$HERE/dist/platforms.json', JSON.stringify(globalThis.__opcMultiPost.platforms,null,2)+'\n');
console.log(Object.keys(globalThis.__opcMultiPost.platforms).length+' platforms');"
printf 'leaperone/MultiPost-Extension %s (Apache-2.0)\n' "$(git -C "$SRC" rev-parse HEAD)" > "$HERE/dist/SOURCE"
