import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";

const NATIVE_DEEP_LINK_EVENT = "openwork:deep-link-native";
const NATIVE_MENU_OPEN_SETTINGS_EVENT = "openwork:native-menu:open-settings";
const NATIVE_MENU_TOGGLE_SIDEBAR_EVENT = "openwork:native-menu:toggle-sidebar";
const NATIVE_MENU_CHECK_UPDATES_EVENT = "openwork:native-menu:check-updates";
const NATIVE_MENU_ZOOM_EVENT = "openwork:native-menu:zoom";
const AUTOMATION_RUNNER_CREDENTIAL_REJECTED_EVENT = "openwork:automation-runner:credential-rejected";
let windowFullscreen = ipcRenderer.sendSync("openwork:window-fullscreen-sync") === true;

function normalizePlatform(value) {
  if (value === "darwin" || value === "linux") return value;
  if (value === "win32") return "windows";
  return "linux";
}

function applyShellDocumentMarkers() {
  try {
    const root = document?.documentElement;
    if (!root) return false;

    root.dataset.openworkShell = "electron";
    root.dataset.windowFullscreen = String(windowFullscreen);
    root.classList.add("openwork-electron");
    if (process.platform === "darwin") {
      root.classList.add("openwork-platform-mac");
    } else if (process.platform === "win32") {
      root.classList.add("openwork-platform-windows");
    } else if (process.platform === "linux") {
      root.classList.add("openwork-platform-linux");
    }
    return true;
  } catch {
    return false;
  }
}

function notifyMenuOverlayDismiss() {
  ipcRenderer.send("openwork:menu-overlay:dismiss");
}

function installMenuOverlayDismissListeners() {
  try {
    const target = window;
    target.addEventListener("pointerdown", notifyMenuOverlayDismiss, { capture: true });
    target.addEventListener("wheel", notifyMenuOverlayDismiss, { capture: true, passive: true });
    target.addEventListener("keydown", notifyMenuOverlayDismiss, { capture: true });
    return true;
  } catch {
    return false;
  }
}

// Web links leave the app: they open in the person's own browser.
function openLink(url) {
  ipcRenderer.send("openwork:link:open", { url });
}

if (process.isMainFrame) {
  window.addEventListener("click", (event) => {
    if (!event.isTrusted || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
    if (!anchor || anchor.isContentEditable || anchor.hasAttribute("download")) return;
    if (!/^(https?:)?\/\//i.test(anchor.getAttribute("href") ?? "")) return;
    let url;
    try { url = new URL(anchor.href); } catch { return; }
    if (!["http:", "https:"].includes(url.protocol)) return;
    if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openLink(url.href);
  }, { capture: true });
}

// Selected text and ordinary editors use Chromium's native context-menu event.
// Explicit editor action menus compose their own editing + formatting menu.
window.addEventListener("contextmenu", (event) => {
  const eventPath = event.composedPath();
  const composedEditor = eventPath.some((node) => node instanceof HTMLElement && node.hasAttribute("data-native-context-menu-editable"));
  const editable = eventPath.some((node) => node instanceof HTMLElement && (
    node.isContentEditable || node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
  ));
  const selection = window.getSelection();
  const selectedTarget = event.target instanceof Node && selection?.toString() && selection.containsNode(event.target, true);
  if (!composedEditor && (editable || selectedTarget)) {
    event.stopImmediatePropagation();
    return;
  }
  if (composedEditor) return;
  // Preserve Chromium's image hit-test and pixel clipboard operation, including
  // linked images. Do not let surrounding message/link menus swallow it.
  if (eventPath.some((node) => node instanceof HTMLImageElement)) {
    event.stopImmediatePropagation();
    return;
  }
  const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
  if (!anchor || anchor.isContentEditable || anchor.hasAttribute("download")) return;
  const href = anchor.getAttribute("href") ?? "";
  if (!/^(https?:)?\/\//i.test(href)) return;
  let url;
  try { url = new URL(anchor.href); } catch { return; }
  if (!["http:", "https:"].includes(url.protocol)) return;
  if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  ipcRenderer.send("openwork:link:contextMenu", { url: url.href, point: { x: event.clientX, y: event.clientY } });
}, { capture: true });

let desktopBootstrap = null;
let desktopDistribution = null;
try {
  desktopBootstrap = ipcRenderer.sendSync("openwork:desktop-bootstrap-sync");
  desktopDistribution = ipcRenderer.sendSync("openwork:desktop-distribution-sync");
} catch {
  desktopBootstrap = null;
  desktopDistribution = null;
}

contextBridge.exposeInMainWorld("__OPENWORK_ELECTRON__", {
  invokeDesktop(command, ...args) {
    return ipcRenderer.invoke("openwork:desktop", command, ...args);
  },
  sessionPins: {
    read() { return ipcRenderer.sendSync("openwork:session-pins:read"); },
    update(change) { return ipcRenderer.sendSync("openwork:session-pins:update", change); },
  },
  computer: {
    // The agent needs computer use the chat does not have yet; null when answered.
    onRequest(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("openwork:computer:request", handler);
      return () => ipcRenderer.removeListener("openwork:computer:request", handler);
    },
  },
  dictation: {
    onEvent(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("openwork:dictation:event", handler);
      return () => ipcRenderer.removeListener("openwork:dictation:event", handler);
    },
  },
  automationRunner: {
    onCredentialRejected(callback) {
      const handler = () => callback();
      ipcRenderer.on(AUTOMATION_RUNNER_CREDENTIAL_REJECTED_EVENT, handler);
      return () => ipcRenderer.removeListener(AUTOMATION_RUNNER_CREDENTIAL_REJECTED_EVENT, handler);
    },
  },
  fileSystem: {
    getPathForFile(file) {
      return webUtils.getPathForFile(file);
    },
  },
  shell: {
    openExternal(url) {
      return ipcRenderer.invoke("openwork:shell:openExternal", url);
    },
    relaunch() {
      return ipcRenderer.invoke("openwork:shell:relaunch");
    },
  },
  system: {
    getArchitectureInfo() {
      return ipcRenderer.invoke("openwork:system:architecture");
    },
  },
  migration: {
    readSnapshot() {
      return ipcRenderer.invoke("openwork:migration:read");
    },
    ackSnapshot() {
      return ipcRenderer.invoke("openwork:migration:ack");
    },
  },
  brandIcon: {
    apply(url) {
      return ipcRenderer.invoke("openwork:desktop", "__applyBrandIcon", url ?? null);
    },
    getState() {
      return ipcRenderer.invoke("openwork:desktop", "__getBrandIconState");
    },
  },
  dev: {
    evalRelaunch() {
      return ipcRenderer.invoke("openwork:desktop", "__evalRelaunch");
    },
  },
  updater: {
    getChannel() {
      return ipcRenderer.invoke("openwork:updater:getChannel");
    },
    setChannel(channel) {
      return ipcRenderer.invoke("openwork:updater:setChannel", channel);
    },
    check(channel, targetVersion, options) {
      return ipcRenderer.invoke("openwork:updater:check", channel, targetVersion, options);
    },
    download() {
      return ipcRenderer.invoke("openwork:updater:download");
    },
    installAndRestart() {
      return ipcRenderer.invoke("openwork:updater:installAndRestart");
    },
    /** Subscribe to incremental download progress from electron-updater. */
    onDownloadProgress(callback) {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on("openwork:updater:download-progress", handler);
      return () => {
        ipcRenderer.removeListener("openwork:updater:download-progress", handler);
      };
    },
  },
  recovery: {
    recordHealthy() {
      return ipcRenderer.invoke("openwork:recovery:recordHealthy");
    },
    list(policy) {
      return ipcRenderer.invoke("openwork:recovery:list", policy);
    },
    restorePrevious() {
      return ipcRenderer.invoke("openwork:recovery:restorePrevious");
    },
    use(id) {
      return ipcRenderer.invoke("openwork:recovery:use", id);
    },
  },
  // Development-only observation of native popup menus; main registers no handler otherwise.
  ...(process.env.OPENWORK_DEV_MODE === "1" ? {
    contextMenu: {
      inspect() { return ipcRenderer.invoke("openwork:context-menu:inspect"); },
      choose(id) { return ipcRenderer.invoke("openwork:context-menu:choose", id); },
      dismiss() { return ipcRenderer.invoke("openwork:context-menu:dismiss"); },
    },
  } : {}),
  aiopc: {
    connection() { return ipcRenderer.invoke("openwork:aiopc:connection"); },
  },
  terminal: {
    create(options) { return ipcRenderer.invoke("openwork:terminal:create", options); },
    write(terminalId, data) { return ipcRenderer.invoke("openwork:terminal:write", terminalId, data); },
    resize(terminalId, cols, rows) { return ipcRenderer.invoke("openwork:terminal:resize", terminalId, cols, rows); },
    kill(terminalId) { return ipcRenderer.invoke("openwork:terminal:kill", terminalId); },
    onData(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("openwork:terminal:data", handler);
      return () => ipcRenderer.removeListener("openwork:terminal:data", handler);
    },
    onExit(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("openwork:terminal:exit", handler);
      return () => ipcRenderer.removeListener("openwork:terminal:exit", handler);
    },
  },
  meta: {
    desktopBootstrap,
    distribution: desktopDistribution,
    initialDeepLinks: [],
    platform: normalizePlatform(process.platform),
    version: process.versions.electron,
    evalFatalBootstrapFailure: process.env.OPENWORK_EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE ?? null,
  },
});

if (
  process.env.OPENWORK_EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE
  && (process.env.OPENWORK_EVAL_RECOVERY_CANDIDATES || process.env.OPENWORK_EVAL_RECOVERY_RELEASES)
) {
  contextBridge.exposeInMainWorld("__openworkRecoveryControl", {
    snapshot() {
      return ipcRenderer.invoke("openwork:recovery:evalSnapshot");
    },
    select(id) {
      return ipcRenderer.invoke("openwork:recovery:use", id);
    },
  });
}

ipcRenderer.on(NATIVE_DEEP_LINK_EVENT, (_event, urls) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NATIVE_DEEP_LINK_EVENT, { detail: urls }));
});

ipcRenderer.on(NATIVE_MENU_OPEN_SETTINGS_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_OPEN_SETTINGS_EVENT));
});

ipcRenderer.on(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT));
});

ipcRenderer.on(NATIVE_MENU_CHECK_UPDATES_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_CHECK_UPDATES_EVENT));
});

ipcRenderer.on(NATIVE_MENU_ZOOM_EVENT, (_event, action) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NATIVE_MENU_ZOOM_EVENT, { detail: action }));
});

ipcRenderer.on(BROWSER_BOUNDS_INVALIDATED_EVENT, () => {
  lastBrowserGeometry = null;
  window.dispatchEvent(new Event(BROWSER_BOUNDS_INVALIDATED_EVENT));
});

ipcRenderer.on("openwork:window-fullscreen", (_event, fullscreen) => {
  windowFullscreen = fullscreen === true;
  applyShellDocumentMarkers();
});

if (!applyShellDocumentMarkers() && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", applyShellDocumentMarkers, { once: true });
}

if (!installMenuOverlayDismissListeners() && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", installMenuOverlayDismissListeners, { once: true });
}
