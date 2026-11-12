/**
 * What the AIOPC window itself may navigate to.
 *
 * The window shows the app and nothing else: its own files, its local
 * services, the page it is already on. A website that tries to load in its
 * place — a clicked link, a stray automation — opens in the person's own
 * browser instead, so the app never disappears behind a web page.
 */

/** @param {string} url @param {string | null | undefined} currentUrl */
export function isMainWindowAllowedNavigation(url, currentUrl) {
  if (!url) return true;
  if (url.startsWith("file://") || url.startsWith("data:")) return true;
  try {
    const target = new URL(url);
    if (target.hostname === "127.0.0.1" || target.hostname === "localhost" || target.hostname === "[::1]") return true;
    if (!currentUrl || currentUrl === "about:blank") return true;
    return target.origin === new URL(currentUrl).origin;
  } catch {
    return true;
  }
}

/** A web address that should leave the app for the person's browser. */
export function isExternalWebUrl(url) {
  return /^https?:\/\//i.test(String(url ?? ""));
}
