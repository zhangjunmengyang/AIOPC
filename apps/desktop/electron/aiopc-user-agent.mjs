import { session } from "electron";

/** The built-in browser's storage, shared by every conversation's tabs. */
const BROWSER_SESSION_PARTITION = "persist:openwork-browser";

/**
 * Chrome's own user agent, without the app and Electron tokens Electron adds.
 * Platforms treat unknown embedded browsers as suspicious at login.
 */
export function standardChromeUserAgent(userAgent) {
  return String(userAgent)
    .split(" ")
    .filter((token) => !/^(Electron|AIOPC|OpenWork|@openwork)[/]/i.test(token))
    .join(" ");
}

export function useStandardUserAgent() {
  const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
  browserSession.setUserAgent(standardChromeUserAgent(browserSession.getUserAgent()));
}
