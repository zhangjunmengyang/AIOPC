import { processBlankSlateProfile, resolveBlankSlateLaunch } from "./blank-slate-profile.mjs";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globalOpencodeConfigDir, workspaceOpencodeConfigCandidates } from "@openwork/paths";

import { configureFakeMediaForTests, installMediaPermissionHandlers } from "./media-permissions.mjs";
import { registerMigrationIpc } from "./migration.mjs";
import { registerSessionPins } from "./session-pins.mjs";
import { createRuntimeManager, createSystemCaCertificateVerifyProc } from "./runtime.mjs";
import { registerUpdaterIpc, resolveAppVersion } from "./updater.mjs";
import { createUiControlServer } from "./ui-control-server.mjs";
import { createApplicationMenu } from "./app-menu.mjs";
import { createNativeContextMenus } from "./context-menu.mjs";
import { createNativeDictation, createSpeechDictation } from "./native-dictation.mjs";
import { isExternalWebUrl, isMainWindowAllowedNavigation } from "./main-window-navigation.mjs";
import { deferBrowserStop } from "@openwork/computer-use/browser-navigation";
import { createComputerControl } from "@openwork/computer-use/computer-control";
import { createComputerAgentPermissions } from "./computer-agent-permissions.mjs";
import { installComputerHelper } from "./computer-helper-install.mjs";
import { createLocalComputerAdapter } from "./computer-local.mjs";
import { createComputerScripting } from "./computer-scripting.mjs";
import { remoteComputerAdapters } from "./computer-targets.mjs";
import { createWindowsComputerAdapter } from "./computer-windows.mjs";
import { resetPermissionEntry, resolvePermissionEntry } from "./computer-permission-entry.mjs";
import { createWorkspaceStore } from "./workspace-store.mjs";
import {
  buildNukeManifest,
  executeNukeFreshStart,
  runPendingNukeCleanup,
} from "./nuke.mjs";
import { openExternalUrl } from "./open-external.mjs";
import { chatOutputFolder, listChatOutputFiles, openChatWorkspaceFile, opensFromChatOutput, readChatOutputImage, resolveChatFilePath, resolveWorkspaceFileLaunch } from "./workspace-file-access.mjs";
import { createOpenWithApplications, installedApplicationCommand } from "./open-with-applications.mjs";
const openWithApplications = createOpenWithApplications();
import { resolveAppIdentifier, resolveUserDataPath } from "./dev-profile.mjs";
import { fetchAgentContextDiagnosticsResponse } from "./agent-context-diagnostics-fetch.mjs";
import { fetchFiniteDesktopHttp } from "./finite-http-fetch.mjs";
import { createDesktopTransferRegistry } from "./binary-transfer.mjs";
import {
  createLinuxDesktopIntegration,
} from "./linux-desktop-integration.mjs";
import { resolveDesktopDistribution } from "./desktop-distribution.mjs";
import {
  applyWindowsTaskbarIcon,
  windowsBrandShortcutDetails,
  windowsBrandShortcutFileName,
  windowsInstalledShortcutFileName,
  windowsInstalledExecutablePath,
  windowsIconFromNativeImage,
} from "./brand-icon-windows.mjs";
import { createWindowsShortcutScheduler, readWindowsShortcutMarker } from "./windows-shortcut.mjs";
import { resetMacDockIcon } from "./brand-icon-darwin.mjs";
import { createDesktopVaultKeyProvider } from "./secure-vault-key.mjs";
import { installStdioErrorHandlers } from "./stdio-errors.mjs";
import {
  createRendererCrashRecovery,
  installSocketTypeOfServiceGuard,
  runDetachedTask,
} from "./process-resilience.mjs";
import { createQuitSequencer } from "./quit-sequence.mjs";
import { createAiopcService } from "./aiopc-service.mjs";
import { createSandboxBrowser } from "./sandbox-browser.mjs";
import { createKeepAwake } from "./keep-awake.mjs";
import { attachFloatingViewWindow, floatingViewWindowOptions } from "./floating-view-window.mjs";
import { createStartupLog, startupPhase, withStartupPhase } from "./startup-log.mjs";
import { createWindowStateStore } from "./window-state.mjs";

// Startup milestones (epoch ms) for the renderer's one-per-launch startup
// diagnostics. The OS process creation time includes module loading; the
// time this module started evaluating is the fallback.
const MAIN_MODULE_STARTED_AT = Date.now();
function resolveProcessStartedAt() {
  const getCreationTime = Reflect.get(process, "getCreationTime");
  const creationTime = typeof getCreationTime === "function" ? getCreationTime.call(process) : null;
  return typeof creationTime === "number" && Number.isFinite(creationTime) && creationTime > 0 && creationTime <= MAIN_MODULE_STARTED_AT
    ? Math.round(creationTime)
    : MAIN_MODULE_STARTED_AT;
}
/** @type {import("@openwork/types/desktop-ipc").DesktopStartupTimings} */
const startupTimings = {
  processStartedAt: resolveProcessStartedAt(),
  windowShownAt: null,
  engineSettledAt: null,
  engine: null,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const desktopPackageMetadata = require("../package.json");
// Electron 35 eagerly resolves every export in a named ESM import, including
// safeStorage. Loading through CommonJS keeps safeStorage lazy so isolated demo
// profiles do not show macOS's native keychain dialog before our switches run.
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net: electronNet,
  powerSaveBlocker,
  Notification: ElectronNotification,
  screen,
  session,
  shell,
} = require("electron");
const startNativeDictation = createNativeDictation({
  platform: process.platform, menu: Menu, processId: process.pid, systemRoot: process.env.SystemRoot,
});
const speechDictation = createSpeechDictation({
  platform: process.platform,
  helperPath: path.join(app.isPackaged ? path.join(process.resourcesPath, "helpers") : path.resolve(__dirname, "..", "resources", "helpers"),
    process.platform === "win32" ? "openwork-dictation.exe" : "openwork-dictation"),
  infoPlist: path.resolve(path.dirname(process.execPath), "..", "Info.plist"),
  exists: existsSync,
  readText: (file) => readFileSync(file, "utf8"),
});
const pty = require(["node", "pty"].join("-"));
const NATIVE_DEEP_LINK_EVENT = "openwork:deep-link-native";
const isDevMode = process.env.OPENWORK_DEV_MODE === "1";
const DESKTOP_DISTRIBUTION = resolveDesktopDistribution();
const TAURI_APP_IDENTIFIER = DESKTOP_DISTRIBUTION.appIdentifier;
const DEV_APP_IDENTIFIER = `${DESKTOP_DISTRIBUTION.appIdentifier}.dev`;
const DESKTOP_PROTOCOL_SCHEME = DESKTOP_DISTRIBUTION.protocolScheme;
const DEFAULT_APP_NAME =
  (!app.isPackaged ? process.env.OPENWORK_ELECTRON_APP_NAME?.trim() : "") ||
  (isDevMode ? `${DESKTOP_DISTRIBUTION.appName} - Dev` : DESKTOP_DISTRIBUTION.appName);
const BLANK_SLATE_LAUNCH = resolveBlankSlateLaunch({
  appName: DEFAULT_APP_NAME,
  profile: processBlankSlateProfile,
});
const APP_NAME = BLANK_SLATE_LAUNCH.appName;
const currentDisplayAppName = APP_NAME;
installStdioErrorHandlers();
installSocketTypeOfServiceGuard();
const BASE_APP_IDENTIFIER = isDevMode ? DEV_APP_IDENTIFIER : TAURI_APP_IDENTIFIER;
const APP_IDENTIFIER = resolveAppIdentifier({
  appIdentifierOverride: process.env.OPENWORK_ELECTRON_APP_IDENTIFIER,
  appRootPath: APP_ROOT,
  baseAppIdentifier: BASE_APP_IDENTIFIER,
  devAppIdentifier: DEV_APP_IDENTIFIER,
  devProfile: process.env.OPENWORK_DEV_PROFILE,
  isDevMode,
  isPackaged: app.isPackaged,
});
if (BLANK_SLATE_LAUNCH.enabled || process.env.OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN === "1") {
  // Fresh, isolated development profiles otherwise trigger macOS's native
  // "Login" keychain prompt as soon as Chromium persists an authenticated
  // cookie. That modal blocks the entire Electron main loop and makes the demo
  // appear frozen. Production never sets this flag and continues to use the
  // system keychain normally.
  app.commandLine.appendSwitch("use-mock-keychain");
}
const RELEASE_DOWNLOAD_BASE_URL = "https://github.com/zhangjunmengyang/AIOPC/releases/latest/download";
const RELEASE_PAGE_URL = "https://github.com/zhangjunmengyang/AIOPC/releases/latest";
const DOCS_PAGE_URL = "https://github.com/zhangjunmengyang/AIOPC#readme";
const applicationMenu = createApplicationMenu({
  appName: APP_NAME,
  docsUrl: DOCS_PAGE_URL,
  getWindow: () => createMainWindow(),
});

// Must match COMPUTER_POPOUT_PREFIX in the app's computer-popout.ts.
const COMPUTER_POPOUT_NAME = /^openwork-computer-view-\d+$/;

// Keep each chat's chosen computer in app data outside the workspace.
// Advanced settings switch for demos; lasts until OpenWork quits. The launch variable turns it on at start.
let computerRecordableOverlay = process.env.OPENWORK_COMPUTER_USE_RECORDABLE_OVERLAY === "1";
const computerTargetsPath = () => path.join(app.getPath("userData"), "computer-use-targets.json");
// The System Settings entry macOS lists for computer use: the helper's own
// bundle, which takes responsibility for itself so grants never restart OpenWork.
let computerPermissionEntry = null;
const computerHelperBundle = () => [process.resourcesPath, path.resolve(__dirname, "..", "resources")]
  .map((root) => root && path.join(root, "helpers", "AIOPC Computer Use.app"))
  .find((candidate) => candidate && existsSync(candidate)) ?? null;
const readComputerPermissionEntry = () => (computerPermissionEntry ??= resolvePermissionEntry({ helperBundle: computerHelperBundle(), fallbackName: APP_NAME })
  .catch(() => ({ name: APP_NAME, bundleId: null, ours: false })));
const computerControl = createComputerControl({
  // App scripting drives Mac apps; Windows does not offer computer_script.
  // Blender reads the bridge from disk, so packaged builds unpack it beside app.asar.
  ...(process.platform !== "win32" ? { runScript: createComputerScripting({
    stateDir: path.join(app.getPath("userData"), "computer-scripting"),
    bridgeScript: path.join(__dirname, "computer-scripting", "openwork_blender.py").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`),
  }) } : {}),
  // A chat's own output folder: computer saves there need no approval, so it must be a real
  // folder OpenWork made, never a link to somewhere else.
  saveFolder: async (sessionId) => {
    const folder = chatOutputFolder(app.getPath("downloads"), sessionId);
    if (!folder) return null;
    await mkdir(folder, { recursive: true });
    const real = await realpath(folder);
    return real === folder && (await lstat(folder)).isDirectory() ? real : null;
  },
  // Where computer steps spend their time: on this computer, or waiting for the model.
  onTiming: (_sessionId, step) => console.info(`[computer] ${step.name} computer ${Math.round(step.computerMs)} ms${step.modelMs === undefined ? "" : ` · model ${Math.round(step.modelMs)} ms`}${step.followed === undefined ? "" : step.followed ? " · in view" : " · background"}`),
  runProgram: async (request, host, signal, options) => (await import("@openwork/computer-use/runtime")).runComputerProgram(request, host, signal, options),
  browserTask: (request, options) => sandboxBrowser.browserTask(request, options),
  readRemoteFeatureEnabled: async () => true,
  // This computer first, then any configured VM (see computer-targets.mjs).
  adapters: [process.platform === "win32" ? createWindowsComputerAdapter({
    resourcesPath: process.resourcesPath,
    appRoot: path.resolve(__dirname, ".."),
  }) : createLocalComputerAdapter({
    resourcesPath: process.resourcesPath,
    appRoot: path.resolve(__dirname, ".."),
    installHelper: async (binary) => !app.isPackaged ? binary : installComputerHelper(binary, {
      helpersRoot: path.join(process.resourcesPath, "helpers"),
      directory: path.join(app.getPath("userData"), "computer-use"),
    }),
    permissionEntry: async () => (await readComputerPermissionEntry()).name,
    recordableOverlay: () => computerRecordableOverlay,
    onSetupReturn: async () => {
      const window = await createMainWindow();
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      app.focus({ steal: true });
    },
  }), ...remoteComputerAdapters()],
  standing: {
    read: async () => {
      try {
        const saved = JSON.parse(await readFile(computerTargetsPath(), "utf8"));
        return {
          targets: saved?.targets && typeof saved.targets === "object" ? saved.targets : {},
          ...(typeof saved?.computer === "string" ? { computer: saved.computer } : {}),
        };
      } catch { return { targets: {} }; }
    },
    write: async (state) => {
      const target = computerTargetsPath();
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state), "utf8");
      await rename(temporary, target);
    },
  },
  permissionEntry: async () => {
    const entry = await readComputerPermissionEntry();
    return { name: entry.name, ours: entry.ours };
  },
  // Files and the clipboard between apps follow the organization's Agent permissions:
  // with no rule the agent goes ahead and nothing asks.
  movePolicy: ({ kind, sessionId }) => computerAgentPermissions.check({ kind, sessionId }),
  // The chat asks the person when the agent needs computer use it does not have yet.
  onRequest: (sessionId, request) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("openwork:computer:request", { sessionId, request });
  },
});
/** Computer use changes app consent; only the main OpenWork window may ask. */
function assertComputerSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("Computer use controls require the main OpenWork window.");
  }
}

const computerAgentPermissions = createComputerAgentPermissions({
  readRules: async () => [],
  confirm: async (rule) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const answer = await dialog.showMessageBox(mainWindow, {
      type: "question", buttons: ["Allow in this chat", "Cancel"], defaultId: 1, cancelId: 1,
      message: "Let the agent use your computer in this chat?",
      detail: `Allow computer access for ${rule.source} in this chat.`,
    });
    return answer.response === 0;
  },
});

/** @param {string} message */
function computerPolicyDenied(message) {
  return { ok: false, error: { code: "organization_policy_denied", message } };
}

/** The chat a call belongs to: a subagent's is the chat that started it, as the trusted bridge reports. */
const computerChatOf = (args) => computerControl.parallelAgents() && typeof args?.rootSessionId === "string" && args.rootSessionId ? args.rootSessionId : args?.sessionId;

/** @param {string} sessionId */
async function checkComputerPermission(sessionId) {
  const decision = await computerAgentPermissions.check({ kind: "computer", sessionId });
  if (decision.effect === "deny") return computerPolicyDenied(decision.message);
  if (decision.effect === "ask" && !await computerAgentPermissions.approveComputer(sessionId, decision.rule)) {
    return computerPolicyDenied("Computer use was not approved in this chat. No action ran.");
  }
  return null;
}

/** The renderer reports the `agentQuestions` feature; the engine offers ask_without_waiting while it is on. */
let agentQuestionsEnabled = false;

const uiControlServer = createUiControlServer({
  app,
  appName: APP_NAME,
  appIdentifier: APP_IDENTIFIER,
  getWindow: () => createMainWindow(),
  browserTask: (args, options) => sandboxBrowser.browserTask(args, options),
  computerTask: async (args, options) => {
    if (!["computer_status", "computer_close"].includes(args?.name)) {
      const denied = await checkComputerPermission(computerChatOf(args));
      if (denied) return denied;
    }
    return computerControl.execute(args, options);
  },
  computerProgram: async (args, options) => {
    if (args?.surface === "computer") {
      const denied = await checkComputerPermission(computerChatOf(args));
      if (denied) return denied;
    }
    return computerControl.program(args, options);
  },
  computerScript: async (args, options) => {
    const decision = await computerAgentPermissions.check({ kind: "script", sessionId: args?.sessionId });
    if (decision.effect === "deny") return computerPolicyDenied(decision.message);
    return computerControl.script(args, { ...options, approveEachScript: decision.effect === "ask" });
  },
  computerEnabled: () => computerControl.featureEnabled(),
  computerParallel: () => computerControl.parallelAgents(),
  agentQuestionsEnabled: () => agentQuestionsEnabled,
});

const terminalProcesses = new Map();
let nextTerminalId = 1;

function defaultTerminalShell() {
  if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe";
  return process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}

async function resolveTerminalCwd(cwd) {
  const fallback = os.homedir();
  if (typeof cwd !== "string" || !cwd.trim()) return fallback;
  const candidate = path.resolve(cwd);
  const info = await stat(candidate).catch(() => null);
  return info?.isDirectory() ? candidate : fallback;
}

function terminalForSender(event, terminalId) {
  const terminal = terminalProcesses.get(String(terminalId ?? ""));
  if (!terminal || terminal.webContentsId !== event.sender.id) return null;
  return terminal;
}

function killTerminal(terminalId) {
  const terminal = terminalProcesses.get(terminalId);
  if (!terminal) return;
  terminalProcesses.delete(terminalId);
  try { terminal.process.kill(); } catch { /* already gone */ }
}

function killTerminalsForWebContents(webContentsId) {
  for (const [terminalId, terminal] of terminalProcesses.entries()) {
    if (terminal.webContentsId === webContentsId) killTerminal(terminalId);
  }
}

// Production Electron shares the same on-disk state folder as the Tauri shell
// so in-place migration is a no-op for almost every file. Dev mode uses the
// separate dev identifier so it can run beside the production app.
//
// Dev profile precedence: OPENWORK_ELECTRON_USERDATA (explicit profile path)
// wins over everything; then OPENWORK_ELECTRON_APP_IDENTIFIER; then
// OPENWORK_DEV_PROFILE in unpackaged dev; then the legacy identifier default.
app.setName(APP_NAME);
app.setAppUserModelId(APP_IDENTIFIER);
if (BLANK_SLATE_LAUNCH.homePath) app.setPath("home", BLANK_SLATE_LAUNCH.homePath);
if (
  app.isPackaged
  && !BLANK_SLATE_LAUNCH.enabled
  && process.env.OPENWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION !== "1"
  && !(process.platform === "linux" && process.env.APPIMAGE)
) {
  app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL_SCHEME);
}
const userDataPath = BLANK_SLATE_LAUNCH.userDataPath ?? resolveUserDataPath({
  appDataPath: app.getPath("appData"),
  appIdentifier: APP_IDENTIFIER,
  userDataOverride: process.env.OPENWORK_ELECTRON_USERDATA,
});
app.setPath("userData", userDataPath);
const desktopStartupLog = createStartupLog({ directory: path.join(userDataPath, "logs") });
const endAppReady = startupPhase("app.ready");
app.once("quit", () => desktopStartupLog.close());
const linuxDesktopIntegration = createLinuxDesktopIntegration({
  app,
  dialog,
  appName: APP_NAME,
  distribution: "public",
});

// Resolve and cache the app icon (reused for BrowserWindow + mac dock).
// Packaged builds ship icons via electron-builder config, but for `dev:electron`
// the Electron default icon is shown without this.
function resolveAppIconPath() {
  const candidates = [
    // Dev: match Tauri's separate dev icon so the dev app is visibly distinct.
    ...(isDevMode
      ? [
          path.resolve(__dirname, "../resources/icons/dev/icon.png"),
          path.resolve(__dirname, "../resources/icons/dev/128x128@2x.png"),
          path.resolve(__dirname, "../resources/icons/dev/icon-dev.icns"),
        ]
      : []),
    // Repo-relative path to the Electron resource icon set.
    path.resolve(__dirname, "../resources/icons/icon.png"),
    // Packaged Windows and Linux builds ship runtime icons via extraResources.
    path.join(process.resourcesPath ?? "", "icons", "linux", "512x512.png"),
    path.join(process.resourcesPath ?? "", "icons", "icon.png"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function normalizeRuntimeArch(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["arm64", "aarch64", "arm64e"].includes(normalized)) return "arm64";
  if (["x64", "x86_64", "amd64"].includes(normalized)) return "x64";
  return normalized || "unknown";
}

function isMacRunningUnderRosetta() {
  if (process.platform !== "darwin" || process.arch !== "x64") return false;
  try {
    return execFileSync("/usr/sbin/sysctl", ["-in", "sysctl.proc_translated"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() === "1";
  } catch {
    return false;
  }
}

function resolveSystemArch() {
  if (process.platform === "darwin" && isMacRunningUnderRosetta()) return "arm64";
  if (process.platform === "win32") {
    return normalizeRuntimeArch(
      process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE || os.arch(),
    );
  }
  if (typeof os.machine === "function") return normalizeRuntimeArch(os.machine());
  return normalizeRuntimeArch(os.arch());
}

function platformDownloadSlug() {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  return "linux";
}

function downloadAssetArch(arch) {
  if (process.platform === "linux" && arch === "x64") return "x86_64";
  return arch;
}

function downloadAssetExtension() {
  if (process.platform === "darwin") return "dmg";
  if (process.platform === "win32") return "exe";
  return "AppImage";
}

function updaterManifestName(arch) {
  if (process.platform === "darwin") return "latest-mac.yml";
  if (process.platform === "win32") return "latest.yml";
  return arch === "arm64" ? "latest-linux-arm64.yml" : "latest-linux.yml";
}

function archLabel(arch) {
  if (arch === "arm64") return "ARM";
  if (arch === "x64") return "Intel";
  return arch;
}

function parseUpdaterManifestFiles(raw) {
  const files = [];
  let current = null;
  for (const line of String(raw || "").split(/\r?\n/)) {
    const start = line.match(/^\s*-\s+url:\s*(.+?)\s*$/);
    if (start) {
      current = { url: start[1].trim().replace(/^['"]|['"]$/g, "") };
      files.push(current);
      continue;
    }
    const prop = line.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.+?)\s*$/);
    if (prop && current) {
      current[prop[1]] = prop[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
  return files.filter((file) => file.url);
}

function selectDownloadFile(files, arch) {
  const assetArch = downloadAssetArch(arch);
  const expected = `-${assetArch}-`;
  const extension = downloadAssetExtension();
  const matchingArch = files.filter((file) => file.url.includes(expected));
  return (
    matchingArch.find((file) => file.url.endsWith(`.${extension}`)) ||
    matchingArch.find((file) => file.url.endsWith(".zip")) ||
    matchingArch[0] ||
    null
  );
}

async function resolveCorrectArchitectureDownloadUrl(arch) {
  const manifestUrl = `${RELEASE_DOWNLOAD_BASE_URL}/${updaterManifestName(arch)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await electronNet.fetch(manifestUrl, {
      signal: controller.signal,
      headers: { Accept: "text/yaml, text/plain, */*" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const selected = selectDownloadFile(parseUpdaterManifestFiles(await response.text()), arch);
    if (!selected?.url) return null;
    return /^https?:\/\//i.test(selected.url)
      ? selected.url
      : new URL(selected.url, `${RELEASE_DOWNLOAD_BASE_URL}/`).toString();
  } catch (error) {
    console.warn("[architecture] failed to resolve latest download URL", error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveArchitectureInfo() {
  const appArch = normalizeRuntimeArch(process.arch);
  const systemArch = resolveSystemArch();
  const version = app.getVersion();
  const targetArch = systemArch === "arm64" || systemArch === "x64" ? systemArch : appArch;
  const assetName = `aiopc-${platformDownloadSlug()}-${downloadAssetArch(targetArch)}-${version}.${downloadAssetExtension()}`;
  // Only check release metadata when this installation needs another architecture.
  const latestDownloadUrl = appArch === systemArch ? null : await resolveCorrectArchitectureDownloadUrl(targetArch);
  const hasCorrectArchitectureDownload = Boolean(latestDownloadUrl);
  return {
    appArch,
    appArchLabel: archLabel(appArch),
    systemArch,
    systemArchLabel: archLabel(systemArch),
    mismatch: appArch !== systemArch && hasCorrectArchitectureDownload,
    platform: process.platform === "win32" ? "windows" : process.platform,
    version,
    downloadUrl: latestDownloadUrl || `${RELEASE_DOWNLOAD_BASE_URL}/${assetName}`,
    releaseUrl: RELEASE_PAGE_URL,
  };
}

const APP_ICON_PATH = resolveAppIconPath();
const APP_ICON_IMAGE = APP_ICON_PATH ? nativeImage.createFromPath(APP_ICON_PATH) : null;
function scheduleBlankSlateProfileCleanup() {
  if (!BLANK_SLATE_LAUNCH.rootPath) return;
  try {
    const child = spawn(process.execPath, [
      path.join(__dirname, "blank-slate-cleanup.mjs"),
      String(process.pid),
      BLANK_SLATE_LAUNCH.rootPath,
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    child.once("error", (error) => {
      console.warn("[blank-slate] failed to schedule temporary profile cleanup", error);
    });
    child.unref();
  } catch (error) {
    console.warn("[blank-slate] failed to schedule temporary profile cleanup", error);
  }
}

function defaultAppWindowsIconPath() {
  return path.join(app.getPath("userData"), "openwork-stock.ico");
}

let cachedWindowsProgramsPath = null;
function windowsProgramsPath() {
  if (cachedWindowsProgramsPath) return cachedWindowsProgramsPath;
  const userProfile = app.getPath("userData").split(/[\\/]AppData[\\/]/i)[0];
  cachedWindowsProgramsPath = path.join(userProfile, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs");
  return cachedWindowsProgramsPath;
}

function windowsBrandShortcutPath() {
  return path.join(windowsProgramsPath(), windowsBrandShortcutFileName(currentDisplayAppName));
}

function windowsInstalledShortcutPath() {
  return path.join(windowsProgramsPath(), windowsInstalledShortcutFileName(APP_NAME));
}

function windowsBrandShortcutMarkerPath() {
  return path.join(app.getPath("userData"), "windows-brand-shortcut.txt");
}

function windowsExecutablePath() {
  return windowsInstalledExecutablePath({
    packaged: app.isPackaged,
    execPath: app.getPath("exe"),
    resourcesPath: process.resourcesPath,
    shortcutPath: windowsBrandShortcutPath(),
  });
}

async function readWindowsBrandShortcutMarker() {
  return (await readWindowsShortcutMarker(windowsBrandShortcutMarkerPath())).shortcutPath;
}

let resolveShortcutWindowReady;
let resolveShortcutRuntimeReady;
const shortcutWindowReady = new Promise((resolve) => { resolveShortcutWindowReady = resolve; });
const shortcutRuntimeReady = new Promise((resolve) => { resolveShortcutRuntimeReady = resolve; });
const scheduleWindowsShortcut = createWindowsShortcutScheduler({
  ready: () => Promise.all([shortcutWindowReady, shortcutRuntimeReady]),
});

function registerWindowsBrandShortcut(appId, appIconPath) {
  if (process.platform !== "win32") return;
  scheduleWindowsShortcut({
    shell,
    shortcutPath: windowsBrandShortcutPath(),
    installedShortcutPath: windowsInstalledShortcutPath(),
    markerPath: windowsBrandShortcutMarkerPath(),
    details: windowsBrandShortcutDetails({
      target: windowsExecutablePath(),
      appId,
      appIconPath,
      appName: currentDisplayAppName,
    }),
  });
}

async function removeWindowsBrandShortcut() {
  if (process.platform !== "win32") return;
  const shortcutPath = await readWindowsBrandShortcutMarker();
  if (shortcutPath) await rm(shortcutPath, { force: true });
  await rm(windowsBrandShortcutMarkerPath(), { force: true });
}

function brandIconFailure(reason, error) {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  console.warn(`[brand-icon] ${reason}${detail ? `: ${detail}` : ""}`);
  return { ok: false, reason };
}

async function applyAppIconImage(image, { taskbarIconPath = null, taskbarAppId = APP_IDENTIFIER } = {}) {
  if (!image || image.isEmpty()) return brandIconFailure("invalid-image");
  try {
    if (process.platform === "darwin") {
      if (!app.dock) return brandIconFailure("dock-unavailable");
      app.dock.setIcon(image);
      return { ok: true };
    }

    if (process.platform === "win32") {
      if (!taskbarIconPath || !existsSync(taskbarIconPath)) {
        return brandIconFailure("taskbar-icon-missing");
      }
      if (!mainWindow) return { ok: true };
      await applyWindowsTaskbarIcon(mainWindow, {
        image,
        appId: taskbarAppId,
        appIconPath: taskbarIconPath,
        relaunchCommand: windowsExecutablePath(),
        relaunchDisplayName: currentDisplayAppName,
      });
    } else {
      if (!mainWindow) return brandIconFailure("window-unavailable");
      mainWindow.setIcon(image);
    }
    return { ok: true };
  } catch (error) {
    return brandIconFailure("os-apply-failed", error);
  }
}

async function applyDefaultAppIconImage() {
  let image = APP_ICON_IMAGE;
  let taskbarIconPath = null;
  if (process.platform === "darwin") {
    // Packaged macOS builds have no loose default icon file (APP_ICON_IMAGE
    // is null), so reset the dock via dock.setIcon(null) to restore the
    // bundle icon instead of silently leaving the branded icon in place.
    try {
      const result = resetMacDockIcon(app.dock, image);
      return result.ok ? result : brandIconFailure(result.reason);
    } catch (error) {
      return brandIconFailure("os-apply-failed", error);
    }
  }
  if (process.platform === "win32") {
    try {
      // The queued stock registration replaces/removes the old brand shortcut.
      // Do not erase its marker on every config reconciliation.
      app.setAppUserModelId(APP_IDENTIFIER);
    } catch (error) {
      return brandIconFailure("shortcut-remove-failed", error);
    }
    if (image && !image.isEmpty()) {
      try {
        taskbarIconPath = defaultAppWindowsIconPath();
        await writeWindowsIconFile(image, taskbarIconPath);
      } catch (error) {
        return brandIconFailure("stock-icon-unavailable", error);
      }
    } else {
      try {
        const executableIcon = await app.getFileIcon(process.execPath, { size: "large" });
        if (executableIcon && !executableIcon.isEmpty()) image = executableIcon;
        taskbarIconPath = process.execPath;
      } catch (error) {
        return brandIconFailure("stock-icon-unavailable", error);
      }
    }
  }
  if (!image || image.isEmpty()) {
    // Linux: the packaged window/launcher icon is managed by the desktop
    // integration, so a missing loose icon is a safe no-op.
    return process.platform === "win32" ? brandIconFailure("stock-icon-unavailable") : { ok: true };
  }
  if (process.platform === "win32" && taskbarIconPath) {
    try {
      registerWindowsBrandShortcut(APP_IDENTIFIER, taskbarIconPath);
    } catch (error) {
      return brandIconFailure("shortcut-write-failed", error);
    }
  }
  return applyAppIconImage(image, {
    taskbarIconPath,
    taskbarAppId: APP_IDENTIFIER,
  });
}

async function focusMainWindowFromNotification() {
  const win = await createMainWindow();
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * @param {unknown} input
 * @returns {import("@openwork/types/desktop-ipc").DesktopNotificationResult}
 */
function showDesktopNotification(input) {
  if (!ElectronNotification.isSupported()) {
    return { ok: false, reason: "notifications unsupported" };
  }

  const record = input && typeof input === "object" ? input : {};
  const title = String(Reflect.get(record, "title") ?? "").trim();
  if (!title) {
    return { ok: false, reason: "missing title" };
  }

  const body = String(Reflect.get(record, "body") ?? "").trim();
  const icon = APP_ICON_IMAGE;
  const options = {
    title,
    ...(body ? { body } : {}),
    ...(Reflect.get(record, "silent") === true ? { silent: true } : {}),
    ...(icon && !icon.isEmpty() ? { icon } : {}),
  };

  try {
    const notification = new ElectronNotification(options);
    notification.on("click", () => {
      runDetachedTask("focus window from notification", focusMainWindowFromNotification);
    });
    notification.show();
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "failed to show notification";
    return { ok: false, reason };
  }
}

async function writeWindowsIconFile(image, destination) {
  const tempPath = `${destination}.${process.pid}-${Date.now()}.tmp`;
  try {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(tempPath, windowsIconFromNativeImage(image));
    await rename(tempPath, destination);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function registerWindowsDisplayShortcut() {
  if (process.platform !== "win32") return;
  runDetachedTask("prepare Windows shortcut icon", async () => {
    await Promise.all([shortcutWindowReady, shortcutRuntimeReady]);
    await prepareWindowsDisplayShortcut();
  });
}

async function prepareWindowsDisplayShortcut() {
  const stockImage = APP_ICON_IMAGE ?? await app.getFileIcon(windowsExecutablePath(), { size: "large" });
  const iconPath = defaultAppWindowsIconPath();
  await writeWindowsIconFile(stockImage, iconPath);
  registerWindowsBrandShortcut(APP_IDENTIFIER, iconPath);
}

const INITIAL_APP_ICON_IMAGE = APP_ICON_IMAGE;
if (process.platform === "darwin" && INITIAL_APP_ICON_IMAGE && !INITIAL_APP_ICON_IMAGE.isEmpty() && app.dock) {
  app.dock.setIcon(INITIAL_APP_ICON_IMAGE);
}

// Expose the Chrome DevTools Protocol for local debugging and test harnesses.
// Use OPENWORK_ELECTRON_REMOTE_DEBUG_PORT to pin a specific port; otherwise
// probe for a free one starting at 9223.
// Must resolve before app.commandLine.appendSwitch (before `ready`).
function probePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1" }, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function findFreeCdpPort(candidates) {
  for (const port of candidates) {
    if (await probePort(port)) return port;
  }
  return 0;
}

const explicitCdpPort = Number.parseInt(
  process.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT?.trim() ?? "",
  10,
);
// The app's own DevTools port is for development and test harnesses only. Nothing in AIOPC drives
// this window over DevTools (the AI browses in the project environment), and an open port would let
// any program on the machine do so.
const remoteDebugPort = Number.isFinite(explicitCdpPort) && explicitCdpPort > 0
  ? explicitCdpPort
  : isDevMode && !app.isPackaged ? await findFreeCdpPort([9223, 9224, 9225, 9226, 9227]) : 0;
if (remoteDebugPort > 0) {
  app.commandLine.appendSwitch("remote-debugging-port", String(remoteDebugPort));
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}
// Publish the resolved port; child processes (and the shells they spawn)
// inherit it through the environment.
process.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT = String(remoteDebugPort);
if (isDevMode && !app.isPackaged) {
  const cdpAddress = remoteDebugPort > 0 ? `http://127.0.0.1:${remoteDebugPort}` : "disabled";
  console.log(`[openwork] dev profile=${app.getPath("userData")} cdp=${cdpAddress}`);
}

// Apply extra Chromium flags from ELECTRON_EXTRA_LAUNCH_ARGS.
// Used in headless/Daytona environments to pass e.g. --disable-gpu.
const extraLaunchArgs = (process.env.ELECTRON_EXTRA_LAUNCH_ARGS ?? "").trim();
if (extraLaunchArgs) {
  for (const arg of extraLaunchArgs.split(/\s+/)) {
    const cleaned = arg.replace(/^--/, "");
    if (!cleaned) continue;
    const eqIdx = cleaned.indexOf("=");
    if (eqIdx > 0) {
      app.commandLine.appendSwitch(cleaned.slice(0, eqIdx), cleaned.slice(eqIdx + 1));
    } else {
      app.commandLine.appendSwitch(cleaned);
    }
  }
}
configureFakeMediaForTests(app, envFlagEnabled("OPENWORK_ELECTRON_FAKE_MEDIA"));
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:4096";
function envFlagEnabled(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

const IDLE_ENGINE_INFO = Object.freeze({
  running: false,
  runtime: "direct",
  managedByServer: false,
  baseUrl: null,
  projectDir: null,
  hostname: null,
  port: null,
  opencodeUsername: null,
  opencodePassword: null,
  opencodeBinPath: null,
  opencodeBinSource: null,
  pid: null,
  lastStdout: null,
  lastStderr: null,
});

const IDLE_OPENWORK_SERVER_INFO = Object.freeze({
  running: false,
  host: null,
  port: null,
  baseUrl: null,
  clientToken: null,
  ownerToken: null,
  hostToken: null,
  managedOpencodeBinPath: null,
  managedOpencodeBinSource: null,
  logFilePath: null,
  pid: null,
  lastStdout: null,
  lastStderr: null,
});

const IDLE_ROUTER_INFO = Object.freeze({
  running: false,
  version: null,
  workspacePath: null,
  opencodeUrl: null,
  healthPort: null,
  pid: null,
  lastStdout: null,
  lastStderr: null,
});

let mainWindow = null;
const pendingDeepLinks = [];
const nativeContextMenus = createNativeContextMenus({ Menu, clipboard, getWindow: () => mainWindow });

let aiopcService;
const workspaceStore = createWorkspaceStore({ app, onWorkspaceStateChanged: state =>
  aiopcService?.syncAuthorizedRoots(state.workspaces.map(entry => entry?.path).filter(value => typeof value === "string")) });

const desktopTransfers = createDesktopTransferRegistry();


function normalizePlatform(value) {
  if (value === "darwin" || value === "linux") return value;
  if (value === "win32") return "windows";
  return "linux";
}

function forwardedDeepLinks(argv) {
  return argv
    .slice(1)
    .map((entry) => entry.trim())
    .filter(
      (entry) =>
        entry.startsWith(`${DESKTOP_PROTOCOL_SCHEME}://`) ||
        (!app.isPackaged && entry.startsWith("openwork-dev://")) ||
        entry.startsWith("https://") ||
        entry.startsWith("http://"),
    );
}

function queueDeepLinks(urls) {
  const nextUrls = urls.filter(Boolean);
  if (nextUrls.length === 0) return;
  pendingDeepLinks.push(...nextUrls);
  if (mainWindow?.webContents) {
    mainWindow.webContents.send(NATIVE_DEEP_LINK_EVENT, nextUrls);
  }
}

function flushPendingDeepLinks() {
  if (!mainWindow?.webContents || pendingDeepLinks.length === 0) return;
  const urls = pendingDeepLinks.splice(0, pendingDeepLinks.length);
  mainWindow.webContents.send(NATIVE_DEEP_LINK_EVENT, urls);
}

function globalOpencodeRoot() {
  return globalOpencodeConfigDir();
}

function execResult(ok, stdout = "", stderr = "", status = ok ? 0 : 1) {
  return { ok, status, stdout, stderr };
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(targetPath) {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

function validateSkillName(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
    throw new Error("skill name must be kebab-case");
  }
  return trimmed;
}

// AIOPC runs only on the user's own model providers: OpenWork's hosted free models stay off.
process.env.OPENWORK_DISABLE_FREE_INFERENCE = "1";
process.env.OPENWORK_DISABLE_HOSTED_MODELS = "1";
aiopcService = createAiopcService({ app, desktopRoot: path.resolve(__dirname, ".."), workspaceStore });
// The AI browses in the project's own environment, not inside this app.
const sandboxBrowser = createSandboxBrowser({ app, aiopcService,
  resolveSessionContext: async (sessionId) => {
    const runtime = await runtimeManager.openworkServerInfo();
    if (!runtime?.running || !runtime.baseUrl || !runtime.hostToken) throw new Error("会话服务还没有就绪");
    const response = await electronNet.fetch(new URL("/runtime/session-context", runtime.baseUrl).href, {
      method: "POST", headers: { "Content-Type": "application/json", "x-openwork-host-token": runtime.hostToken },
      body: JSON.stringify({ sessionId }), signal: AbortSignal.timeout(15_000),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value?.error?.message ?? value?.error ?? "无法确认会话所属项目");
    return value;
  },
});
aiopcService.configureEnvironment();
const runtimeManager = createRuntimeManager({
  app,
  desktopRoot: path.resolve(__dirname, ".."),
  listLocalWorkspacePaths: () => workspaceStore.listLocalWorkspacePaths(),
  // This callback stays in Electron's main process. Engine tools and shell
  // commands cannot approve a Drive write by replaying a token or HTTP reply.
  driveFileApproval: async ({ provider, action, path: filePath, name, fileId, webViewLink, mode }) => {
    const win = await createMainWindow();
    const saving = action === "push";
    const microsoft = provider === "microsoft-365";
    const service = microsoft ? "OneDrive or SharePoint" : "Google Drive";
    const label = saving ? (mode === "copy" ? "Save a copy" : microsoft ? "Save to Microsoft 365" : "Save to Drive") : action === "pull" ? (microsoft ? "Download from Microsoft 365" : "Download from Drive") : "Discard local edits";
    const identity = `${service}: ${name}\nFile ID: ${fileId}${webViewLink ? `\n${webViewLink}` : ""}`;
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      message: action === "overwrite" ? `Replace the local copy of ${name}?` : `${label}: ${name}`,
      detail: saving
        ? `${identity}\n\n${filePath}\n\n${mode === "copy" ? `Creates a new file next to the original in ${service}.` : `Replaces the file in ${service}. People with access to it will see your changes.`}`
        : `${identity}\n\n${filePath}\n\n${action === "pull" ? "Downloads this file from your connected account into the workspace." : `Discards the local edits and downloads the current ${service} file.`}`,
      buttons: ["Cancel", label], defaultId: 0, cancelId: 0, noLink: true,
    });
    return response === 1;
  },
  // When OPENWORK_ENCRYPTION_KEY is set, skip the safeStorage provider so it does not shadow the documented env override used by CI or headless runs.
  localManagedMcpVaultKey: process.env.OPENWORK_ENCRYPTION_KEY?.trim()
    ? undefined
    : createDesktopVaultKeyProvider({
        filePath: path.join(app.getPath("userData"), "local-managed-mcp-vault-key.bin"),
        loadSafeStorage: () => require("electron").safeStorage,
      }),
});
let runtimeDisposedForQuit = false;
let runtimeDisposeInProgress = false;
let runtimeBootstrapPromise = null;

const SHUTDOWN_SCREEN_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { height: 100%; margin: 0; background: #0b0b0f; color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { display: grid; place-items: center; }
      main { display: grid; gap: 10px; justify-items: center; }
      .spinner { width: 22px; height: 22px; border: 2px solid rgba(244,244,245,.25); border-top-color: #f4f4f5; border-radius: 50%; animation: spin .9s linear infinite; }
      .title { font-size: 15px; font-weight: 600; }
      .body { font-size: 13px; color: #a1a1aa; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <main>
      <div class="spinner" aria-hidden="true"></div>
      <div class="title">Stopping OpenWork services</div>
      <div class="body">Closing local workers and background services...</div>
    </main>
  </body>
</html>`;

// Replace the current document in place. Navigating to a data: URL instead
// spawns a speculative renderer process, and Electron aborts any child launch
// with CHECK_EQ(program, child_path) once the app bundle is gone from disk.
function showShutdownScreen() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  try {
    win.show();
    void win.webContents.executeJavaScript(
      `document.open(); document.write(${JSON.stringify(SHUTDOWN_SCREEN_HTML)}); document.close();`,
      true,
    ).catch(() => undefined);
  } catch {
    // Ignore renderer teardown races during quit.
  }
}

async function disposeRuntimeBeforeQuit() {
  if (runtimeDisposedForQuit || runtimeDisposeInProgress) return;
  runtimeDisposeInProgress = true;
  try {
    await runtimeManager.dispose().catch(() => undefined);
    runtimeDisposedForQuit = true;
  } finally {
    runtimeDisposeInProgress = false;
  }
}

const keepAwake = createKeepAwake({ powerSaveBlocker });
/** Windows already watched so their keep-awake request ends when they close. */
const keepAwakeSenders = new Set();

const quitSequencer = createQuitSequencer({
  stop: async () => {
    keepAwake.releaseAll();
    showShutdownScreen();
    await Promise.all([
      disposeRuntimeBeforeQuit(),
      uiControlServer.stop(),
      computerControl.reset(true),
      Promise.resolve(sandboxBrowser.close()),
    ]);
    // Runtime shutdown releases browser leases through OPC before stopping its HTTP service.
    await aiopcService.stop();
  },
  quit: () => {
    scheduleBlankSlateProfileCleanup();
    app.quit();
  },
  exit: () => app.exit(0),
});
const quitInProgress = () => quitSequencer.phase() !== "idle";

function assertOpenworkServerReady(info) {
  if (!info?.running) {
    throw new Error("OpenWork server did not stay running after startup.");
  }
  if (!info.baseUrl) {
    throw new Error("OpenWork server did not report a base URL after startup.");
  }
  if (!info.ownerToken && !info.clientToken) {
    throw new Error("OpenWork server did not report an access token after startup.");
  }
  return info;
}

async function bootRuntimeForSelectedWorkspace() {
  if (typeof process.env.OPENWORK_EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE === "string") {
    throw new Error(process.env.OPENWORK_EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE);
  }
  const list = await workspaceStore.readWorkspaceState();
  const selectedId = list.selectedId || list.activeId || list.workspaces[0]?.id || "";
  const workspace = selectedId
    ? list.workspaces.find((entry) => entry?.id === selectedId)
    : list.workspaces[0];
  const workspaceRoot = String(workspace?.path ?? "").trim();
  if (!workspaceRoot) {
    return { ok: true, skipped: true, reason: "no-local-workspace" };
  }

  const workspacePaths = [];
  for (const entry of list.workspaces) {
    const workspacePath = String(entry?.path ?? "").trim();
    if (workspacePath && !workspacePaths.includes(workspacePath)) workspacePaths.push(workspacePath);
  }
  if (!workspacePaths.includes(workspaceRoot)) workspacePaths.unshift(workspaceRoot);

  let bootWorkspace = workspace;
  let bootWorkspaceRoot = workspaceRoot;
  let engine;
  try {
    engine = await runtimeManager.engineStart(workspaceRoot, {
      runtime: "direct",
      workspacePaths,
    });
  } catch (error) {
    const fallback = list.workspaces.find((entry) => {
      const candidatePath = String(entry?.path ?? "").trim();
      return candidatePath && candidatePath !== workspaceRoot;
    });
    const fallbackRoot = String(fallback?.path ?? "").trim();
    if (!fallback || !fallbackRoot) throw error;
    console.warn("[runtime] selected workspace failed during boot; trying fallback workspace", {
      selectedWorkspaceId: workspace?.id ?? null,
      fallbackWorkspaceId: fallback.id ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    const fallbackWorkspacePaths = [
      fallbackRoot,
      ...workspacePaths.filter((entry) => entry !== fallbackRoot && entry !== workspaceRoot),
    ];
    engine = await runtimeManager.engineStart(fallbackRoot, {
      runtime: "direct",
      workspacePaths: fallbackWorkspacePaths,
    });
    bootWorkspace = fallback;
    bootWorkspaceRoot = fallbackRoot;
    await workspaceStore.writeWorkspaceState({
      ...list,
      selectedId: String(fallback.id ?? ""),
      watchedId: String(fallback.id ?? ""),
    }).catch(() => undefined);
  }
  const openworkServer = assertOpenworkServerReady(await runtimeManager.openworkServerInfo());
  return { ok: true, skipped: false, engine, openworkServer, workspaceId: bootWorkspace.id ?? null };
}

function startRuntimeBootstrap() {
  runtimeBootstrapPromise = withStartupPhase("runtime.start", bootRuntimeForSelectedWorkspace).catch(async (error) => {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  });
  void runtimeBootstrapPromise.then(recordStartupEngineSettled);
  return runtimeBootstrapPromise;
}

// Only the launch's first boot counts; a Reload after a failure is a retry.
function recordStartupEngineSettled(result) {
  // Cosmetic Shell work never precedes the initial runtime readiness attempt.
  if (result?.ok !== false) resolveShortcutRuntimeReady();
  if (startupTimings.engineSettledAt !== null) return;
  startupTimings.engineSettledAt = Date.now();
  startupTimings.engine = result?.ok === false ? "failed" : result?.skipped ? "skipped" : "ready";
}

function ensureRuntimeBootstrap() {
  const attempt = runtimeBootstrapPromise ?? startRuntimeBootstrap();
  return attempt.then((result) => {
    // A failed boot is reported once. The next request, such as Reload on the
    // error screen, starts a fresh attempt instead of replaying this failure.
    if (result?.ok === false && runtimeBootstrapPromise === attempt) {
      runtimeBootstrapPromise = null;
    }
    return result;
  });
}

function resolveOpencodeConfigPath(scope, projectDir) {
  if (scope === "project") {
    if (!String(projectDir ?? "").trim()) {
      throw new Error("projectDir is required");
    }
    return workspaceOpencodeConfigCandidates(projectDir);
  } else if (scope === "global") {
    const root = globalOpencodeRoot();
    return [path.join(root, "opencode.jsonc"), path.join(root, "opencode.json")];
  } else {
    throw new Error("scope must be 'project' or 'global'");
  }
}

async function selectOpencodeConfigPath(candidates) {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return candidates[0];
}

async function readOpencodeConfig(scope, projectDir) {
  const chosenPath = await selectOpencodeConfigPath(resolveOpencodeConfigPath(scope, projectDir));
  const exists = await pathExists(chosenPath);
  return {
    path: chosenPath,
    exists,
    content: exists ? await readFile(chosenPath, "utf8") : null,
  };
}

async function writeOpencodeConfig(scope, projectDir, content) {
  const targetPath = await selectOpencodeConfigPath(resolveOpencodeConfigPath(scope, projectDir));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
  return execResult(true, `Wrote ${targetPath}`);
}

async function collectProjectSkillRoots(projectDir) {
  const roots = [];
  let current = path.resolve(projectDir);

  while (true) {
    const opencodeSkills = path.join(current, ".opencode", "skills");
    const legacySkills = path.join(current, ".opencode", "skill");
    const claudeSkills = path.join(current, ".claude", "skills");

    if (await isDirectory(opencodeSkills)) roots.push(opencodeSkills);
    if (await isDirectory(legacySkills)) roots.push(legacySkills);
    if (await isDirectory(claudeSkills)) roots.push(claudeSkills);

    if (await pathExists(path.join(current, ".git"))) {
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return roots;
}

async function collectGlobalSkillRoots() {
  const roots = [];
  const candidates = [
    path.join(globalOpencodeRoot(), "skills"),
    path.join(os.homedir(), ".claude", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".agent", "skills"),
  ];

  for (const candidate of candidates) {
    if (await isDirectory(candidate)) {
      roots.push(candidate);
    }
  }

  return roots;
}

async function collectSkillRoots(projectDir) {
  const roots = [...(await collectProjectSkillRoots(projectDir)), ...(await collectGlobalSkillRoots())];
  return roots.filter((value, index) => roots.indexOf(value) === index);
}

async function findSkillDirsInRoot(root) {
  const found = [];
  if (!(await isDirectory(root))) return found;

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const direct = path.join(root, entry.name);
    if (await pathExists(path.join(direct, "SKILL.md"))) {
      found.push(direct);
      continue;
    }

    const nestedEntries = await readdir(direct, { withFileTypes: true }).catch(() => []);
    for (const nested of nestedEntries) {
      if (!nested.isDirectory()) continue;
      const nestedDir = path.join(direct, nested.name);
      if (await pathExists(path.join(nestedDir, "SKILL.md"))) {
        found.push(nestedDir);
      }
    }
  }

  return found;
}

function extractFrontmatterValue(raw, keys) {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (!keys.includes(key)) continue;
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (value) return value;
  }
  return null;
}

function extractTrigger(raw) {
  return extractFrontmatterValue(raw, ["trigger", "when"]);
}

function extractDescription(raw) {
  let inFrontmatter = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter || trimmed.startsWith("#")) continue;
    const cleaned = trimmed.replace(/`/g, "");
    return cleaned.length > 180 ? `${cleaned.slice(0, 180)}...` : cleaned;
  }
  return null;
}

async function listLocalSkills(projectDir) {
  if (!String(projectDir ?? "").trim()) {
    throw new Error("projectDir is required");
  }

  const seen = new Set();
  const out = [];
  for (const root of await collectSkillRoots(projectDir)) {
    for (const skillDir of await findSkillDirsInRoot(root)) {
      const name = path.basename(skillDir);
      if (seen.has(name)) continue;
      seen.add(name);
      let raw = "";
      try {
        raw = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
      } catch {
        raw = "";
      }
      out.push({
        name,
        path: skillDir,
        description: extractDescription(raw) ?? undefined,
        trigger: extractTrigger(raw) ?? undefined,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function findSkillFile(projectDir, name) {
  const safeName = validateSkillName(name);
  for (const root of await collectSkillRoots(projectDir)) {
    const direct = path.join(root, safeName, "SKILL.md");
    if (await pathExists(direct)) return direct;

    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(root, entry.name, safeName, "SKILL.md");
      if (await pathExists(nested)) return nested;
    }
  }
  return null;
}

async function ensureProjectSkillRoot(projectDir) {
  if (!String(projectDir ?? "").trim()) {
    throw new Error("projectDir is required");
  }
  const opencodeRoot = path.join(projectDir, ".opencode");
  const legacy = path.join(opencodeRoot, "skill");
  const modern = path.join(opencodeRoot, "skills");
  if ((await isDirectory(legacy)) && !(await pathExists(modern))) {
    await rename(legacy, modern);
  }
  await mkdir(modern, { recursive: true });
  return modern;
}

function activeWindowFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
}

function macosVibrancyForCurrentTheme() {
  return nativeTheme.shouldUseDarkColors ? "under-window" : "sidebar";
}

function applyNativeTheme(mode) {
  nativeTheme.themeSource = mode;

  if (process.platform !== "darwin") {
    return true;
  }

  mainWindow?.setVibrancy(macosVibrancyForCurrentTheme());
  mainWindow?.setBackgroundColor("#00000001");

  return true;
}

// Desktop IPC command registry. Every command invokable from the renderer's
// desktopBridge Proxy (apps/app/src/app/lib/desktop.ts) has exactly one
// entry here; handlers receive the ipcMain event followed by the renderer
// arguments. The @type below asserts this registry against the shared
// DesktopCommandMap contract (packages/types/src/desktop-ipc.ts): a missing,
// extra, or renamed command fails `pnpm --filter @openwork/desktop
// typecheck:electron`.
/** @type {import("@openwork/types/desktop-ipc").DesktopCommandHandlers<import("electron").IpcMainInvokeEvent>} */
const desktopCommandHandlers = {
  "__startNativeDictation": async (event, requestId) => startNativeDictation.start(event, mainWindow, requestId),
  "__cancelNativeDictationStart": async (event, requestId) => startNativeDictation.cancel(event, requestId),
  "__speechDictationMode": async (event) => speechDictation.mode(),
  "__startSpeechDictation": async (event, requestId, language) => speechDictation.start(event, mainWindow, requestId, language),
  "__stopSpeechDictation": async (event, requestId) => speechDictation.stop(event, requestId),
  "__abortSpeechDictation": async (event, requestId) => speechDictation.abort(event, requestId),
  "workspaceBootstrap": async (event, ...args) => {
      return workspaceStore.readWorkspaceState();
  },
  "workspaceSetSelected": async (event, ...args) => {
      return workspaceStore.setSelectedWorkspace(typeof args[0] === "string" ? args[0] : "");
  },
  "workspaceSetRuntimeActive": async (event, ...args) => {
      return workspaceStore.setRuntimeActiveWorkspace(typeof args[0] === "string" && args[0].trim() ? args[0] : null);
  },
  "workspaceCreate": async (event, ...args) => {
      return workspaceStore.createWorkspace(args[0] ?? {});
  },
  "workspaceForget": async (event, ...args) => {
      return workspaceStore.forgetWorkspace(String(args[0] ?? "").trim());
  },
  "workspaceOpenworkRead": async (event, ...args) => {
      return workspaceStore.readWorkspaceOpenworkConfig(String(args[0]?.workspacePath ?? "").trim());
  },
  "workspaceOpenworkWrite": async (event, ...args) => {
      return workspaceStore.writeWorkspaceOpenworkConfig(
        String(args[0]?.workspacePath ?? "").trim(),
        args[0]?.config ?? workspaceStore.defaultWorkspaceOpenworkConfig(""),
      );
  },
  "engineStart": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const options = args[1] ?? {};
      return runtimeManager.engineStart(projectDir, options);
  },
  "runtimeBootstrap": async (event, ...args) => {
      return ensureRuntimeBootstrap();
  },
  "runtimeStatus": async (event, ...args) => {
      return { ...await runtimeManager.runtimeStatus(), desktopStartupLog: desktopStartupLog.read() };
  },
  "engineStop": async (event, ...args) => {
      return runtimeManager.engineStop();
  },
  "engineRestart": async (event, ...args) => {
      return runtimeManager.engineRestart(args[0] ?? {});
  },
  "engineInfo": async (event, ...args) => {
      return runtimeManager.engineInfo();
  },
  "appBuildInfo": async (event, ...args) => {
      return {
        version: app.getVersion(),
        gitSha: process.env.OPENWORK_GIT_SHA ?? null,
        buildEpoch: process.env.OPENWORK_BUILD_EPOCH ?? null,
        openworkDevMode: process.env.OPENWORK_DEV_MODE === "1",
      };
  },
  "startupTimings": async (event, ...args) => {
      return { ...startupTimings };
  },
  "desktopNotificationShow": async (event, ...args) => {
      return showDesktopNotification(args[0] ?? {});
  },
  "desktopSetKeepAwake": async (event, ...args) => {
      const sender = event.sender;
      if (args[0] === true && !keepAwakeSenders.has(sender.id)) {
        keepAwakeSenders.add(sender.id);
        sender.once("destroyed", () => {
          keepAwakeSenders.delete(sender.id);
          keepAwake.forget(sender.id);
        });
      }
      return keepAwake.set(sender.id, args[0] === true);
  },
  "desktopIntegrationStatus": async (event, ...args) => {
      return linuxDesktopIntegration.getStatus();
  },
  "desktopIntegrationInstall": async (event, ...args) => {
      if (BLANK_SLATE_LAUNCH.enabled) throw new Error("Desktop integration is disabled for test profiles.");
      return linuxDesktopIntegration.install(args[0] ?? {});
  },
  "desktopIntegrationRemove": async (event, ...args) => {
      if (BLANK_SLATE_LAUNCH.enabled) throw new Error("Desktop integration is disabled for test profiles.");
      return linuxDesktopIntegration.remove();
  },
  "getUiControlBridgeInfo": async (event, ...args) => {
      try {
        const raw = await readFile(path.join(app.getPath("userData"), "openwork-ui-control.json"), "utf8");
        return JSON.parse(raw);
      } catch {
        return null;
      }
  },
  "getOpenworkUiMcpCommand": async (event, ...args) => {
      if (process.env.OPENWORK_DEV_MODE === "1") {
        return ["node", path.resolve(__dirname, "../../..", "packages/openwork-ui-mcp/index.mjs")];
      }
      return ["npx", "-y", "openwork-ui-mcp"];
  },
  "getOpenworkUiMcpEnvironment": async (event, ...args) => {
      return {
        OPENWORK_UI_CONTROL_DISCOVERY: path.join(app.getPath("userData"), "openwork-ui-control.json"),
      };
  },
  "computerSnapshot": async (event, sessionId) => {
      assertComputerSender(event);
      return computerControl.snapshot({ sessionId: String(sessionId ?? "") });
  },
  "computerCrew": async (event, sessionId, thumbnails) => {
      assertComputerSender(event);
      return computerControl.crew({ sessionId: String(sessionId ?? ""), thumbnails: thumbnails === true });
  },
  "computerStatus": async (event) => {
      assertComputerSender(event);
      return computerControl.status();
  },
  "computerPresentation": async (event, sessionId, visible) => {
      assertComputerSender(event);
      return computerControl.presentation({ sessionId: String(sessionId ?? ""), visible: visible === true });
  },
  "computerFollow": async (event, sessionId, watching) => {
      assertComputerSender(event);
      computerControl.follow({ sessionId: String(sessionId ?? ""), watching: watching === true });
  },
  "computerInteract": async (event, input) => {
      assertComputerSender(event);
      return computerControl.interact({
        sessionId: String(input?.sessionId ?? ""),
        id: String(input?.id ?? ""),
        action: input?.action,
        ...(input?.windowId !== undefined ? { windowId: input.windowId } : {}),
      });
  },
  "computerSetup": async (event, permission) => {
      assertComputerSender(event);
      return computerControl.setup({ permission });
  },
  "computerDismissSetup": async (event, setupId) => {
      assertComputerSender(event);
      await computerControl.dismissSetup({ setupId });
  },
  "computerChoose": async (event, targetId) => {
      assertComputerSender(event);
      return computerControl.chooseComputer({ targetId: String(targetId ?? "") });
  },
  "computerHalt": async (event, sessionId) => {
      assertComputerSender(event);
      return computerControl.halt({ sessionId: String(sessionId ?? "") });
  },
  "computerAnswerRequest": async (event, input) => {
      assertComputerSender(event);
      return computerControl.answerRequest({ sessionId: String(input?.sessionId ?? ""), answer: input?.answer, ...(typeof input?.id === "string" ? { id: input.id } : {}) });
  },
  "computerOpenSavedFile": async (event, input) => {
      assertComputerSender(event);
      // A path from the chat: only a file this chat's computer use saved here launches, and
      // only while it is still a regular file, not a link. Anything else is at most shown in its folder.
      const target = String(input?.path ?? "");
      const sessionId = String(input?.sessionId ?? "");
      const file = await resolveChatFilePath(target);
      if (!file) return { ok: true, action: "unavailable" };
      // Also a file in the chat's own output folder, however the chat made it.
      const launch = input?.reveal !== true && ((computerControl.savedFile({ sessionId, path: target }) && lstatSync(target).isFile())
        || await opensFromChatOutput(chatOutputFolder(app.getPath("downloads"), computerControl.chatOf({ sessionId })), target));
      if (!launch) { shell.showItemInFolder(file); return { ok: true, action: "revealed" }; }
      const error = await shell.openPath(target);
      return error?.trim() ? { ok: false, error } : { ok: true, action: "opened" };
  },
  "computerChatFiles": async (event, input) => {
      assertComputerSender(event);
      // A subagent saves in the folder of the chat that started it.
      const folder = chatOutputFolder(app.getPath("downloads"), computerControl.chatOf({ sessionId: String(input?.sessionId ?? "") }));
      return { files: folder ? await listChatOutputFiles(folder) : [] };
  },
  "computerChatImage": async (event, input) => {
      assertComputerSender(event);
      // An image the chat shows in its reply: only one saved in this chat's own output folder.
      const folder = chatOutputFolder(app.getPath("downloads"), computerControl.chatOf({ sessionId: String(input?.sessionId ?? "") }));
      return readChatOutputImage(folder, String(input?.path ?? ""), { home: app.getPath("home") });
  },
  "computerSetFeatureEnabled": async (event, enabled) => {
      assertComputerSender(event);
      return computerControl.setFeatureEnabled(enabled === true);
  },
  "agentQuestionsSetEnabled": async (event, enabled) => {
      if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Only the main OpenWork window reports features.");
      agentQuestionsEnabled = enabled === true;
      return agentQuestionsEnabled;
  },
  "computerSetRemoteEnabled": async (event, enabled) => {
      assertComputerSender(event);
      return computerControl.setRemoteEnabled(enabled === true);
  },
  "computerSetStandardCodeMode": async (event, enabled) => {
      assertComputerSender(event);
      return computerControl.setStandardCodeMode(enabled === true);
  },
  "computerSetParallelAgents": async (event, enabled) => {
      assertComputerSender(event);
      return computerControl.setParallelAgents(enabled === true);
  },
  "computerRecordableOverlay": async (event) => {
      assertComputerSender(event);
      return computerRecordableOverlay;
  },
  "computerSetRecordableOverlay": async (event, enabled) => {
      assertComputerSender(event);
      computerRecordableOverlay = enabled === true;
      return computerRecordableOverlay;
  },
  // Compatibility for older renderers; background delivery now follows computerUse.
  "computerSetBackgroundEnabled": async (event) => {
      assertComputerSender(event);
      return computerControl.setBackgroundEnabled();
  },
  "computerResetPermission": async (event, permission) => {
      assertComputerSender(event);
      if (permission !== "accessibility" && permission !== "screenRecording") throw new Error("Choose Accessibility or Screen Recording.");
      // Clear only OpenWork's own stale entry, then ask macOS again with a fresh guide.
      await resetPermissionEntry(await readComputerPermissionEntry(), permission);
      await computerControl.dismissSetup({});
      return computerControl.setup({ permission });
  },
  "computerEndTurn": async (event, sessionId) => {
      assertComputerSender(event);
      return computerControl.endTurn({ sessionId: String(sessionId ?? "") });
  },
  "nukeOpenworkAndOpencodeConfigPreview": async (event, ...args) => {
      return buildNukeManifest({
        env: process.env,
        homedir: os.homedir(),
        platform: process.platform,
        userDataPath: app.getPath("userData"),
        workspacePaths: await workspaceStore.listLocalWorkspacePaths(),
      });
  },
  "nukeOpenworkAndOpencodeConfigAndExit": async (event, ...args) => {
      return executeNukeFreshStart({
        app,
        session,
        runtimeManager,
        uiControlServer,
        removeWindowsBrandShortcut,
      }, {
        preserveBootstrap: args[0]?.preserveBootstrap !== false,
        input: {
          env: process.env,
          homedir: os.homedir(),
          platform: process.platform,
          userDataPath: app.getPath("userData"),
          workspacePaths: await workspaceStore.listLocalWorkspacePaths(),
        },
      });
  },
  "openworkServerInfo": async (event, ...args) => {
      return runtimeManager.openworkServerInfo();
  },
  "openworkServerRestart": async (event, ...args) => {
      return runtimeManager.openworkServerRestart(args[0] ?? {});
  },
  "pickDirectory": async (event, ...args) => {
      const options = args[0] ?? {};
      /** @type {import("electron").OpenDialogOptions["properties"]} */
      const properties = options.multiple
        ? ["openDirectory", "createDirectory", "multiSelections"]
        : ["openDirectory", "createDirectory"];
      const result = await dialog.showOpenDialog(activeWindowFromEvent(event), {
        title: options.title,
        defaultPath: options.defaultPath,
        properties,
      });
      if (result.canceled) return null;
      return options.multiple ? result.filePaths : (result.filePaths[0] ?? null);
  },
  "pickFile": async (event, ...args) => {
      const options = args[0] ?? {};
      /** @type {import("electron").OpenDialogOptions["properties"]} */
      const properties = options.multiple ? ["openFile", "multiSelections"] : ["openFile"];
      const result = await dialog.showOpenDialog(activeWindowFromEvent(event), {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
        properties,
      });
      if (result.canceled) return null;
      return options.multiple ? result.filePaths : (result.filePaths[0] ?? null);
  },
  "importSkill": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const sourceDir = String(args[1] ?? "").trim();
      const overwrite = args[2]?.overwrite === true;
      if (!projectDir || !sourceDir) {
        throw new Error("projectDir and sourceDir are required");
      }
      const skillRoot = await ensureProjectSkillRoot(projectDir);
      const name = validateSkillName(path.basename(sourceDir));
      const destination = path.join(skillRoot, name);
      if (await pathExists(destination)) {
        if (!overwrite) {
          return execResult(false, "", `Skill already exists at ${destination}`);
        }
        await rm(destination, { recursive: true, force: true });
      }
      await cp(sourceDir, destination, { recursive: true });
      return execResult(true, `Imported skill to ${destination}`);
  },
  "installSkillTemplate": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const name = validateSkillName(args[1]);
      const content = String(args[2] ?? "");
      const overwrite = args[3]?.overwrite === true;
      const skillRoot = await ensureProjectSkillRoot(projectDir);
      const destination = path.join(skillRoot, name);
      if (await pathExists(destination)) {
        if (!overwrite) {
          return execResult(false, "", `Skill already exists at ${destination}`);
        }
        await rm(destination, { recursive: true, force: true });
      }
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, "SKILL.md"), content, "utf8");
      return execResult(true, `Installed skill to ${destination}`);
  },
  "listLocalSkills": async (event, ...args) => {
      return listLocalSkills(String(args[0] ?? "").trim());
  },
  "readLocalSkill": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const skillPath = await findSkillFile(projectDir, args[1]);
      if (!skillPath) {
        throw new Error("Skill not found");
      }
      return { path: skillPath, content: await readFile(skillPath, "utf8") };
  },
  "writeLocalSkill": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const skillPath = await findSkillFile(projectDir, args[1]);
      if (!skillPath) {
        return execResult(false, "", "Skill not found");
      }
      const content = String(args[2] ?? "");
      const next = content.endsWith("\n") ? content : `${content}\n`;
      await writeFile(skillPath, next, "utf8");
      return execResult(true, `Saved skill ${path.basename(path.dirname(skillPath))}`);
  },
  "uninstallSkill": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const skillPath = await findSkillFile(projectDir, args[1]);
      if (!skillPath) {
        return execResult(false, "", "Skill not found in .opencode/skills or .claude/skills");
      }
      await rm(path.dirname(skillPath), { recursive: true, force: true });
      return execResult(true, `Removed skill ${args[1]}`);
  },
  "updaterEnvironment": async (event, ...args) => {
      const executablePath = app.isPackaged ? app.getPath("exe") : process.execPath;
      return {
        supported: true,
        reason: null,
        executablePath,
        appBundlePath:
          process.platform === "darwin"
            ? path.resolve(executablePath, "../../..")
            : path.dirname(executablePath),
      };
  },
  "readOpencodeConfig": async (event, ...args) => {
      return readOpencodeConfig(String(args[0] ?? "").trim(), String(args[1] ?? "").trim());
  },
  "writeOpencodeConfig": async (event, ...args) => {
      return writeOpencodeConfig(
        String(args[0] ?? "").trim(),
        String(args[1] ?? "").trim(),
        String(args[2] ?? ""),
      );
  },
  "resetOpenworkState": async (event, ...args) => {
      return workspaceStore.resetOpenworkState();
  },
  "opencodeMcpAuth": async (event, ...args) => {
      return runtimeManager.opencodeMcpAuth(String(args[0] ?? "").trim(), String(args[1] ?? "").trim());
  },
  "__resolveChatFilePath": async (event, ...args) => {
      return resolveChatFilePath(args[0]);
  },
  "__openPath": async (event, ...args) => {
      const target = String(args[0] ?? "").trim();
      if (!target) return "Path is required.";
      return shell.openPath(target);
  },
  "__openWorkspaceFile": async (event, ...args) => {
      // Chat links are renderer-derived text. Resolve them on disk here so only a real
      // file inside the real workspace launches; anything else is revealed, never run.
      const workspaceRoot = String(args[0] ?? "").trim();
      const target = String(args[1] ?? "").trim();
      return openChatWorkspaceFile(workspaceRoot, target, {
        reveal: args[2]?.reveal === true,
        openPath: (file) => shell.openPath(file),
        revealPath: (file) => shell.showItemInFolder(file),
      });
  },
  "__revealItemInDir": async (event, ...args) => {
      const target = String(args[0] ?? "").trim();
      if (!target) return "Path is required.";
      if (existsSync(target)) {
        shell.showItemInFolder(target);
        return undefined;
      }
      // The exact file may not exist yet (or path is slightly off); fall back to
      // opening the containing directory so the user still lands in the right place.
      const parent = path.dirname(target);
      if (parent && parent !== target && existsSync(parent)) {
        const error = await shell.openPath(parent);
        return error && error.trim() ? error : undefined;
      }
      return `Could not find "${target}" on disk.`;
  },
  "__getApplicationsForFile": async (event, ...args) => {
      const target = String(args[0] ?? "").trim();
      if (!target) return [];
      const canonicalTarget = await realpath(target).catch(() => null);
      if (!canonicalTarget) return [];
      const platform = process.platform;
      const results = [];

      try {
        if (platform === "darwin") {
          // Scan /Applications and /System/Applications for .app bundles
          const appDirs = ["/Applications", "/System/Applications", "/Applications/Utilities", `${os.homedir()}/Applications`];
          const seen = new Set();
          for (const dir of appDirs) {
            let entries;
            try { entries = await readdir(dir); } catch { continue; }
            for (const entry of entries) {
              if (!entry.endsWith(".app")) continue;
              const appPath = path.join(dir, entry);
              if (seen.has(appPath)) continue;
              seen.add(appPath);
              const name = entry.replace(/\.app$/i, "");
              let icon = null;
              try {
                const img = await app.getFileIcon(appPath, { size: "small" });
                icon = img.isEmpty() ? null : img.toDataURL();
              } catch {}
              results.push({ name, appPath, icon });
            }
          }
        } else if (platform === "linux") {
          // Parse .desktop files in standard directories
          const desktopDirs = ["/usr/share/applications", "/usr/local/share/applications", `${os.homedir()}/.local/share/applications`];
          const seen = new Set();
          for (const dir of desktopDirs) {
            let entries;
            try { entries = await readdir(dir); } catch { continue; }
            for (const entry of entries) {
              if (!entry.endsWith(".desktop")) continue;
              const filePath = path.join(dir, entry);
              if (seen.has(filePath)) continue;
              seen.add(filePath);
              try {
                const content = await readFile(filePath, "utf-8");
                const nameMatch = content.match(/^Name=(.+)$/m);
                const execMatch = content.match(/^Exec=(.+)$/m);
                if (!nameMatch || !execMatch) continue;
                const name = nameMatch[1].trim();
                // The installed desktop entry is the identity. Never return its
                // Exec string as an executable path controlled by the renderer.
                const appPath = filePath;
                let icon = null;
                try {
                  const img = await app.getFileIcon(filePath, { size: "small" });
                  icon = img.isEmpty() ? null : img.toDataURL();
                } catch {}
                results.push({ name, appPath, icon });
              } catch {}
            }
          }
        }
      } catch {}

      openWithApplications.remember(event.sender.id, canonicalTarget, results.map((application) => application.appPath));
      return results;
  },
  "__openWithApp": async (event, ...args) => {
      const requested = String(args[0] ?? "").trim();
      const appPath = String(args[1] ?? "").trim();
      const workspaceRoot = String(args[2] ?? "").trim();
      if (!requested || !appPath) return "Target and app path are required.";
      const decision = await resolveWorkspaceFileLaunch(workspaceRoot, requested);
      if (decision.ok === false) return decision.error;
      const target = decision.path;
      if (!openWithApplications.allows(event.sender.id, target, appPath)) {
        return "Choose an installed application from the file menu.";
      }
      const command = installedApplicationCommand(process.platform, appPath, target);
      if (!command) return "This installed application cannot open files here.";
      try {
        // Both the command and installed app identifier are main-process
        // choices. Never spawn a renderer-supplied executable or use a shell.
        await new Promise((resolve, reject) => {
          execFile(command.command, command.args, (error) => error ? reject(error) : resolve(undefined));
        });
      } catch {
        return "This application could not open the file.";
      }
  },
  "__fetch": async (event, ...args) => {
      const url = String(args[0] ?? "").trim();
      const init = args[1] ?? {};
      if (!url) throw new Error("URL is required.");
      /** @type {RequestInit} */
      const requestInit = {
        method: typeof init.method === "string" ? init.method : undefined,
        headers: init.headers && typeof init.headers === "object" ? init.headers : undefined,
        body: typeof init.body === "string" ? init.body : undefined,
        credentials: "omit",
        cache: "no-store",
      };
      if (init.agentContextDiagnostics && typeof init.agentContextDiagnostics === "object") {
        return fetchAgentContextDiagnosticsResponse(
          electronNet.fetch,
          url,
          requestInit,
          init.agentContextDiagnostics.deadlineAtMs,
        );
      }
      const timeoutMs = Number(init.timeoutMs);
      const fetchResponse = async (callerSignal) => {
        const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
        const signal = callerSignal && deadline ? AbortSignal.any([callerSignal, deadline]) : callerSignal ?? deadline;
        const response = await fetchFiniteDesktopHttp(url, { ...requestInit, signal }, electronNet.fetch);
        return {
          status: response.status,
          statusText: response.statusText,
          headers: Array.from(response.headers.entries()),
          body: await response.text(),
        };
      };
      const method = (requestInit.method ?? "GET").toUpperCase();
      const cancellable = ["GET", "PATCH"].includes(method)
        || (method === "POST" && /\/(?:session\/[^/]+\/abort|permission\/[A-Za-z0-9_-]+\/reply)$/.test(new URL(url).pathname));
      return cancellable && init.transferId
        ? desktopTransfers.run(event, init.transferId, fetchResponse)
        : fetchResponse(undefined);
  },
  "__cancelTransfer": async (event, ...args) => {
      return desktopTransfers.cancel(event, args[0]);
  },
  "__homeDir": async (event, ...args) => {
      return os.homedir();
  },
  "__joinPath": async (event, ...args) => {
      return path.join(...args.map((value) => String(value ?? "")));
  },
  "__setZoomFactor": async (event, ...args) => {
      const factor = Number(args[0]);
      const window = activeWindowFromEvent(event);
      if (!window || !Number.isFinite(factor) || factor <= 0) {
        return false;
      }
      window.webContents.setZoomFactor(factor);
      return true;
  },
  "__setNativeTheme": async (event, ...args) => {
      return applyNativeTheme(String(args[0]));
  },
  "__showContextMenu": async (event, ...args) => {
      return nativeContextMenus.showFromRenderer(event, args[0]);
  },
  "__cancelContextMenu": async (event, ...args) => {
      return nativeContextMenus.cancelFromRenderer(event, args[0]);
  },
  "__setApplicationMenuVisible": async (event, ...args) => {
      return applicationMenu.setVisible(args[0]);
  },
};

if (isDevMode) {
  desktopCommandHandlers.__evalRelaunch = async () => {
    // Chromium persists localStorage/leveldb lazily; force a flush so the
    // relaunched instance sees the same renderer storage (otherwise the app
    // can come back signed out and eval flows misread that as a regression).
    try {
      mainWindow?.webContents.session.flushStorageData();
      session.defaultSession.flushStorageData();
    } catch {
      // Best effort — never block the relaunch on a flush failure.
    }
    setTimeout(() => {
      app.relaunch();
      // Graceful quit (not app.exit) so before-quit teardown runs and managed
      // sidecars are stopped — a hard exit orphans them and they can hold
      // ports (e.g. the CDP debug port) the relaunched instance needs.
      app.quit();
    }, 150);
    return { ok: true };
  };
}

function desktopErrorMessageSegment(error, includeName = false) {
  try {
    if (error && (typeof error === "object" || typeof error === "function")) {
      const message = typeof error.message === "string" ? error.message.trim() : "";
      if (message) {
        const name = typeof error.name === "string" ? error.name.trim() : "";
        return includeName && name && name !== "Error" && !message.startsWith(`${name}:`)
          ? `${name}: ${message}`
          : message;
      }
    }
    return String(error);
  } catch {
    return "Unknown error";
  }
}

function desktopErrorCause(error) {
  try {
    return error && (typeof error === "object" || typeof error === "function") ? error.cause : undefined;
  } catch {
    return undefined;
  }
}

function desktopErrorMessageWithCauses(error) {
  try {
    const messages = [];
    const seenMessages = new Set();
    const seenErrors = new Set();
    let current = error;
    for (let depth = 0; current != null && depth < 8; depth += 1) {
      if (typeof current === "object" || typeof current === "function") {
        if (seenErrors.has(current)) break;
        seenErrors.add(current);
      }
      const message = desktopErrorMessageSegment(current, depth === 0).trim();
      if (message && !seenMessages.has(message)) {
        seenMessages.add(message);
        messages.push(message);
      }
      current = desktopErrorCause(current);
    }
    const combined = messages.join(": ") || "Unknown desktop command error";
    return combined.length > 2000 ? `${combined.slice(0, 1997)}...` : combined;
  } catch {
    return "Unknown desktop command error";
  }
}

async function handleDesktopInvoke(event, command, ...args) {
  const handler = desktopCommandHandlers[command];
  if (!handler) {
    throw new Error(`Electron desktop bridge method is not implemented yet: ${command}`);
  }
  try {
    return await handler(event, ...args);
  } catch (error) {
    throw new Error(desktopErrorMessageWithCauses(error), { cause: error });
  }
}


async function createMainWindow() {
  return withStartupPhase("window.create", createMainWindowInner);
}

async function createMainWindowInner() {
  if (mainWindow) return mainWindow;

  const preloadPath = path.join(__dirname, "preload.mjs");
  const windowAppearanceOptions = {};
  if (process.platform === "darwin") {
    Object.assign(windowAppearanceOptions, {
      backgroundColor: "#00000001",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 20, y: 18 },
      vibrancy: macosVibrancyForCurrentTheme(),
      visualEffectState: "active",
    });
  } else {
    Object.assign(windowAppearanceOptions, {
      titleBarStyle: "hidden",
      titleBarOverlay: { height: 40 },
    });
  }

  const windowIconImage = APP_ICON_IMAGE;
  if (process.platform === "darwin" && windowIconImage && !windowIconImage.isEmpty() && app.dock) {
    app.dock.setIcon(windowIconImage);
  }

  const windowState = createWindowStateStore({
    directory: app.getPath("userData"),
    screen,
    log: (message, error) => console.warn(message, error),
  });
  const restoredWindow = windowState.initialOptions({ width: 1180, height: 820 });

  mainWindow = new BrowserWindow({
    ...restoredWindow.options,
    title: currentDisplayAppName,
    show: false,
    ...(process.platform === "win32" ? { skipTaskbar: true } : {}),
    ...windowAppearanceOptions,
    ...(windowIconImage && !windowIconImage.isEmpty() ? { icon: windowIconImage } : {}),
    webPreferences: {
      // The renderer owns session dispatch + event streams; keep it running
      // while hidden/minimized so background tasks are not interrupted.
      backgroundThrottling: false,
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Enable Chromium's built-in PDF viewer so PDFs render inside the
      // artifact panel (<embed> pointed at a blob URL).
      plugins: true,
    },
  });
  await applyDefaultAppIconImage();
  windowState.track(mainWindow);
  applicationMenu.applyVisibility(mainWindow);

  // Native fullscreen is independent of the DOM Fullscreen API. The preload
  // also reads the initial value, so reloading in fullscreen keeps its layout.
  const publishFullscreen = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("openwork:window-fullscreen", mainWindow.isFullScreen());
  };
  mainWindow.on("enter-full-screen", publishFullscreen);
  mainWindow.on("leave-full-screen", publishFullscreen);

  mainWindow.webContents.on("context-menu", (_event, params) => {
    void nativeContextMenus.showEditing(params).catch((error) => {
      console.warn("[context-menu] Could not open editing menu", error);
    });
  });

  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    mainWindow?.setTitle(currentDisplayAppName);
  });
  mainWindow.setTitle(currentDisplayAppName);

  const endWindowShow = startupPhase("window.show");
  mainWindow.once("ready-to-show", () => {
    if (startupTimings.windowShownAt === null) startupTimings.windowShownAt = Date.now();
    mainWindow?.setTitle(currentDisplayAppName);
    if (process.platform === "win32") mainWindow?.setSkipTaskbar(false);
    if (restoredWindow.maximized) mainWindow?.maximize();
    mainWindow?.show();
    endWindowShow();
    resolveShortcutWindowReady();
    flushPendingDeepLinks();
  });

  // Windows only: never start a staged update while the session is ending.
  mainWindow.on("session-end", () => holdInstallForSessionEnd());

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const recoverRendererCrash = createRendererCrashRecovery({
    reload: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.reload();
    },
    onRepeatedCrash: (details) => {
      dialog.showErrorBox(
        `${APP_NAME} could not recover`,
        `The app renderer stopped repeatedly (${details.reason ?? "unknown reason"}). Quit and reopen OpenWork. Your workspace files were not deleted.`,
      );
    },
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (quitInProgress()) return;
    recoverRendererCrash(details);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // The computer use watch view, popped out of the chat (see computer-popout.ts).
    // The chat renders into it, so it never loads anything else.
    if (url === "about:blank" && COMPUTER_POPOUT_NAME.test(frameName)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          title: "Computer",
          frame: false,
          alwaysOnTop: true,
          fullscreenable: false,
          maximizable: false,
          minimizable: false,
          skipTaskbar: true,
          minWidth: 280,
          minHeight: 200,
        },
      };
    }
    const floatingView = floatingViewWindowOptions({ url, frameName, dark: nativeTheme.shouldUseDarkColors });
    if (floatingView) return { action: "allow", overrideBrowserWindowOptions: floatingView };

    if (url.startsWith("file://")) {
      try {
        runDetachedTask("open local file", () => shell.openPath(fileURLToPath(url)));
      } catch {
        runDetachedTask("open local file externally", () => openExternalUrl(url));
      }

      return { action: "deny" };
    }

    // Links open in the person's own browser; the app never opens web pages in windows of its own.
    runDetachedTask("open external URL", () => openExternalUrl(url));
    return { action: "deny" };
  });

  mainWindow.webContents.on("did-create-window", (child, { frameName }) => {
    if (!floatingViewWindowOptions({ url: "about:blank", frameName })) return;
    attachFloatingViewWindow(child);
    applicationMenu.applyVisibility(child);
    const closeWithMain = () => { if (!child.isDestroyed()) child.close(); };
    mainWindow?.once("closed", closeWithMain);
    child.once("closed", () => mainWindow?.off("closed", closeWithMain));
  });

  mainWindow.webContents.on("did-create-window", (child, { frameName }) => {
    if (!COMPUTER_POPOUT_NAME.test(frameName)) return;
    // Above other apps' windows, so the agent's work stays visible while OpenWork is behind them.
    child.setAlwaysOnTop(true, "floating");
    child.webContents.on("will-navigate", (event) => event.preventDefault());
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const closeWithMain = () => { if (!child.isDestroyed()) child.close(); };
    mainWindow?.once("closed", closeWithMain);
    child.once("closed", () => mainWindow?.off("closed", closeWithMain));
  });

  // A link clicked in the inline PDF viewer reaches both handlers below for
  // the same navigation (`did-start-navigation` first, then `will-navigate`),
  // so open each blocked URL once instead of twice in the person's browser.
  let lastRoutedNavigation = null;
  const routeBlockedNavigationOnce = (url) => {
    const now = Date.now();
    if (lastRoutedNavigation?.url === url && now - lastRoutedNavigation.at < 1000) return;
    lastRoutedNavigation = { url, at: now };
    if (isExternalWebUrl(url)) runDetachedTask("open external URL", () => openExternalUrl(url));
  };
  const allowedInWindow = (url) => isMainWindowAllowedNavigation(url, mainWindow?.webContents.getURL());

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (allowedInWindow(url)) return;
    event.preventDefault();
    routeBlockedNavigationOnce(url);
  });

  // `will-navigate` does NOT fire for CDP `Page.navigate` (it behaves like
  // loadURL), so agent automation that picks the wrong CDP target — the app
  // window itself is the first page target when no browser tab exists — used
  // to replace the entire workspace UI with the website, with no way back
  // (#2000). Catch those at `did-start-navigation`, cancel the load, and
  // open the URL in the person's browser instead.
  let mainNavigationRevision = 0;
  mainWindow.webContents.on("did-start-navigation", (_event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    const revision = ++mainNavigationRevision;
    if (allowedInWindow(url)) return;
    // Capture the originating contents: the window may be replaced before
    // Chromium has unwound its navigation callback. Never stop its successor.
    const contents = mainWindow.webContents;
    const previousUrl = contents.getURL();
    deferBrowserStop(contents, () => mainWindow?.webContents === contents
      && mainNavigationRevision === revision && contents.getURL() === previousUrl);
    routeBlockedNavigationOnce(url);
  });

  const startUrl = process.env.OPENWORK_ELECTRON_START_URL?.trim() || process.env.ELECTRON_START_URL?.trim();
  if (startUrl) {
    await mainWindow.loadURL(startUrl);
  } else {
    const packagedIndexPath = path.join(process.resourcesPath, "app-dist", "index.html");
    const devIndexPath = path.resolve(__dirname, "../../app/dist/index.html");
    await mainWindow.loadFile(app.isPackaged ? packagedIndexPath : devIndexPath);
  }

  return mainWindow;
}

registerSessionPins({
  ipcMain,
  directory: userDataPath,
  isTrusted: event => Boolean(mainWindow && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame),
});

ipcMain.on("openwork:desktop-distribution-sync", (event) => {
  event.returnValue = DESKTOP_DISTRIBUTION;
});
ipcMain.on("openwork:window-fullscreen-sync", (event) => {
  event.returnValue = BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false;
});
ipcMain.handle("openwork:desktop", handleDesktopInvoke);
// A web link in the app opens in the person's browser; right-clicking one offers that or copying it.
const isLinkFromMainWindow = (event) => event.sender === mainWindow?.webContents && event.senderFrame === mainWindow?.webContents.mainFrame;
ipcMain.on("openwork:link:open", (event, payload) => {
  const url = typeof payload?.url === "string" ? payload.url : "";
  if (!isLinkFromMainWindow(event) || !isExternalWebUrl(url) || url.length > 32_768) return;
  runDetachedTask("open external URL", () => openExternalUrl(url));
});
ipcMain.on("openwork:link:contextMenu", (event, payload) => {
  const url = typeof payload?.url === "string" ? payload.url : "";
  if (!isLinkFromMainWindow(event) || !isExternalWebUrl(url) || url.length > 32_768) return;
  const x = Number(payload?.point?.x), y = Number(payload?.point?.y);
  Menu.buildFromTemplate([
    { label: "在浏览器中打开", click: () => runDetachedTask("open external URL", () => openExternalUrl(url)) },
    { label: "复制链接地址", click: () => clipboard.writeText(url) },
  ]).popup({ window: mainWindow, ...(Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : {}) });
});

ipcMain.handle("openwork:shell:openExternal", async (_event, url) => {
  if (typeof url !== "string" || url.trim().length === 0) {
    return { ok: false, error: "empty url" };
  }
  return openExternalUrl(url.trim());
});
ipcMain.handle("openwork:shell:relaunch", async () => {
  app.relaunch();
  app.quit();
});
ipcMain.handle("openwork:system:architecture", async () => resolveArchitectureInfo());
ipcMain.handle("openwork:aiopc:connection", async () => aiopcService.connection());

// ── Terminal IPC ────────────────────────────────────────────────────────
ipcMain.handle("openwork:terminal:create", async (event, options = {}) => {
  const cwd = await resolveTerminalCwd(options?.cwd);
  const cols = Number.isFinite(options?.cols) ? Math.max(20, Math.floor(options.cols)) : 80;
  const rows = Number.isFinite(options?.rows) ? Math.max(5, Math.floor(options.rows)) : 24;
  const terminalId = `term_${nextTerminalId++}`;
  const shellPath = defaultTerminalShell();
  const child = pty.spawn(shellPath, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      OPENWORK_TERMINAL: "1",
    },
  });

  terminalProcesses.set(terminalId, { process: child, webContentsId: event.sender.id });
  event.sender.once("destroyed", () => killTerminalsForWebContents(event.sender.id));
  child.onData((data) => {
    if (event.sender.isDestroyed()) return;
    event.sender.send("openwork:terminal:data", { terminalId, data });
  });
  child.onExit(({ exitCode, signal }) => {
    terminalProcesses.delete(terminalId);
    if (event.sender.isDestroyed()) return;
    event.sender.send("openwork:terminal:exit", { terminalId, exitCode, signal });
  });

  return { terminalId };
});
ipcMain.handle("openwork:terminal:write", (event, terminalId, data) => {
  const terminal = terminalForSender(event, terminalId);
  if (!terminal || typeof data !== "string") return;
  terminal.process.write(data);
});
ipcMain.handle("openwork:terminal:resize", (event, terminalId, cols, rows) => {
  const terminal = terminalForSender(event, terminalId);
  if (!terminal || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
  terminal.process.resize(Math.max(20, Math.floor(cols)), Math.max(5, Math.floor(rows)));
});
ipcMain.handle("openwork:terminal:kill", (event, terminalId) => {
  const terminal = terminalForSender(event, terminalId);
  if (!terminal) return;
  killTerminal(String(terminalId));
});

// Native popups cannot be seen or clicked over CDP. In development only, let the
// app's main frame read the open/last menu as plain data and choose an item.
if (isDevMode && !app.isPackaged) {
  const fromMainFrame = (event) => Boolean(mainWindow) && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame;
  ipcMain.handle("openwork:context-menu:inspect", (event) => (fromMainFrame(event) ? nativeContextMenus.inspect() : null));
  ipcMain.handle("openwork:context-menu:choose", (event, id) => fromMainFrame(event) && nativeContextMenus.choose(id));
  ipcMain.handle("openwork:context-menu:dismiss", (event) => {
    if (!fromMainFrame(event)) return false;
    const { open } = nativeContextMenus.inspect();
    nativeContextMenus.close();
    return open;
  });
}
registerMigrationIpc({ app, ipcMain });
const { ensureAutoUpdater, holdInstallForSessionEnd } = registerUpdaterIpc({
  app,
  ipcMain,
  getMainWindow: () => mainWindow,
  electronNet,
  shell,
  platform: process.platform,
  arch: process.arch,
});

if (!app.requestSingleInstanceLock()) {
  if (isDevMode && !app.isPackaged) {
    console.error(`[openwork] Another OpenWork dev instance already holds this profile directory:
  ${app.getPath("userData")}
The second process is exiting so its CDP port is released.
Run this worktree with an isolated profile: OPENWORK_DEV_PROFILE=auto pnpm dev
or use: pnpm dev:worktree`);
    app.exit(1);
    setImmediate(() => process.exit(1));
  } else {
    app.quit();
  }
} else {
  app.on("before-quit", (event) => quitSequencer.handleBeforeQuit(event));
  app.on("will-quit", () => quitSequencer.handleWillQuit());

  app.on("second-instance", (_event, argv) => {
    runDetachedTask("focus second instance", async () => {
      const win = await createMainWindow();
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      queueDeepLinks(forwardedDeepLinks(argv));
    });
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    runDetachedTask("open deep link", async () => {
      const win = await createMainWindow();
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      queueDeepLinks([url]);
    });
  });

  app.whenReady().then(() => withStartupPhase("bootstrap.apply", async () => {
    endAppReady();
    await aiopcService.syncAuthorizedRoots();
    void aiopcService.start();
    const systemCaCertificates = await runtimeManager.systemCaCertificates();
    session.defaultSession.setCertificateVerifyProc(createSystemCaCertificateVerifyProc(systemCaCertificates));
    installMediaPermissionHandlers(session, () => mainWindow);
    await runPendingNukeCleanup({
      env: process.env,
      homedir: os.homedir(),
      platform: process.platform,
      userDataPath: app.getPath("userData"),
    }).catch((error) => {
      console.warn("[nuke] pending cleanup failed", error);
    });
    if (process.platform === "win32" && !BLANK_SLATE_LAUNCH.enabled) registerWindowsDisplayShortcut();
    applicationMenu.install();
    await runtimeManager.prepareFreshRuntime().catch(() => undefined);

    // Use Tauri's existing workspace state file as canonical so rollback and
    // Electron see the same workspace list. Import the short-lived
    // Electron-only filename only when the shared file is missing.
    await workspaceStore.migrateLegacyElectronWorkspaceStateIfNeeded();
    // Public first launch uses the same folder as the chat-first composer.
    // Provision it before the renderer and runtime read the workspace list.
    const firstLaunchWorkspaceFailure = await workspaceStore.bootstrapFirstLaunchWorkspace();
    if (firstLaunchWorkspaceFailure) {
      console.warn("[workspace] default folder unavailable; continuing without a workspace", firstLaunchWorkspaceFailure);
    }
    await uiControlServer.start().catch((error) => {
      console.warn("[ui-control] failed to start", error);
    });
    startRuntimeBootstrap();

    queueDeepLinks(forwardedDeepLinks(process.argv));
    const win = await createMainWindow();
    if (firstLaunchWorkspaceFailure) {
      runDetachedTask("show default workspace warning", () => dialog.showMessageBox(win, {
        type: "warning",
        message: "OpenWork could not prepare its default folder",
        detail: `OpenWork is open without a workspace. Use Add workspace in the sidebar to choose another folder.\n\n${firstLaunchWorkspaceFailure.error}`,
        buttons: ["Continue"],
      }));
    }
    win.webContents.on("did-finish-load", () => {
      flushPendingDeepLinks();
    });
    if (!BLANK_SLATE_LAUNCH.enabled) {
      setTimeout(() => {
        void linuxDesktopIntegration.maybePrompt(win).catch((error) => {
          console.warn("[desktop-integration] prompt failed", error);
        });
      }, 500);
    }

    // Initialize the packaged updater after the window is up so the user sees
    // a working app first. Renderer-owned checks pass the selected release
    // channel explicitly, avoiding stale stable-feed results for alpha users.
    runDetachedTask("initialize updater", ensureAutoUpdater);
  })).catch((error) => {
    console.error("[desktop] startup failed", error);
    // A quit that arrives mid-startup aborts the pending window load and
    // rejects this chain. showErrorBox is a synchronous modal: raised here it
    // would block the main thread, and the quit, until someone dismissed it.
    if (quitInProgress()) return;
    dialog.showErrorBox(
      `${APP_NAME} could not start`,
      "OpenWork hit an unexpected startup error. Quit and reopen the app. If it continues, switch to a Stable build and share the diagnostics with support.",
    );
    app.quit();
  });

  app.on("activate", () => {
    runDetachedTask("activate window", async () => {
      const win = await createMainWindow();
      win.show();
      win.focus();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
