/** @jsxImportSource react */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { compareVersions } from "../../../../app/lib/version-gate";
import type { ReleaseChannel } from "../../../../app/types";
import { isElectronRuntime, safeStringify } from "../../../../app/utils";
import { t } from "../../../../i18n";
import { useUpdateCheckRequestStore } from "./update-check-request";

export type SettingsUpdateStatus = {
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  lastCheckedAt?: number | null;
  version?: string;
  date?: string;
  notes?: string;
  totalBytes?: number | null;
  downloadedBytes?: number;
  message?: string;
  failedAction?: "check" | "download" | "install";
  checkingForNewer?: boolean;
  checkError?: string;
  checkCooldownUntil?: number;
  newest?: boolean;
  candidate?: {
    version: string;
    totalBytes: number | null;
    date?: string;
    notes?: string;
    channel: ReleaseChannel;
  };
} | null;

type ElectronUpdaterBridge = NonNullable<Window["__OPENWORK_ELECTRON__"]>["updater"] & {
  onDownloadProgress?: (callback: (data: { transferred: number; total: number; percent: number; bytesPerSecond: number }) => void) => (() => void);
};

declare global {
  interface Window {
    __openworkUpdaterEvalBridge?: ElectronUpdaterBridge;
  }
}

type UseElectronUpdaterStateOptions = {
  releaseChannel: ReleaseChannel;
  onReleaseChannelChange: (next: ReleaseChannel) => void;
  updateAutoCheck: boolean;
  updateAutoDownload: boolean;
  setError: (message: string | null) => void;
};

export type ElectronUpdaterEnvState = {
  appVersion: string | null;
  updateEnv: { supported?: boolean; reason?: string | null } | null;
};

export const ELECTRON_UPDATER_UNSUPPORTED_REASON = "Electron updater bridge is unavailable.";

export function unsupportedElectronUpdaterEnvState(): ElectronUpdaterEnvState {
  return {
    appVersion: null,
    updateEnv: { supported: false, reason: ELECTRON_UPDATER_UNSUPPORTED_REASON },
  };
}

export function shouldScheduleElectronUpdateAutoCheck(input: {
  updateAutoCheck: boolean;
  updateEnv: ElectronUpdaterEnvState["updateEnv"];
  autoCheckKey: string | null;
  nextAutoCheckKey: string;
}) {
  return input.updateAutoCheck &&
    input.updateEnv?.supported !== false &&
    input.autoCheckKey !== input.nextAutoCheckKey;
}

type ElectronUpdaterEnvAction =
  | { type: "app-version"; appVersion: string | null }
  | { type: "unsupported"; reason: string };

function electronUpdaterEnvReducer(
  state: ElectronUpdaterEnvState,
  action: ElectronUpdaterEnvAction,
): ElectronUpdaterEnvState {
  switch (action.type) {
    case "app-version":
      return { ...state, appVersion: action.appVersion };
    case "unsupported":
      return {
        ...state,
        updateEnv: { supported: false, reason: action.reason },
      };
  }
}

function electronUpdaterBridge(): ElectronUpdaterBridge | null {
  if (typeof window === "undefined") return null;
  if (import.meta.env.DEV && window.__openworkUpdaterEvalBridge) {
    return window.__openworkUpdaterEvalBridge;
  }
  return window.__OPENWORK_ELECTRON__?.updater ?? null;
}

function describeError(error: unknown) {
  if (error instanceof Error) return error.message;
  const serialized = safeStringify(error);
  return serialized && serialized !== "{}" ? serialized : String(error);
}

function releaseNotesToText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object" && "note" in entry) {
          const note = String((entry as { note?: unknown }).note ?? "");
          return note ? [note] : [];
        }
        return [];
      })
      .join("\n\n") || undefined;
  }
  return undefined;
}

function updateProgress(event: unknown): { downloaded?: number; total?: number } | null {
  if (!event || typeof event !== "object") return null;
  const data = event as { data?: unknown };
  if (!data.data || typeof data.data !== "object") return null;
  const payload = data.data as { chunkLength?: unknown; contentLength?: unknown };
  return {
    downloaded: typeof payload.chunkLength === "number" ? payload.chunkLength : undefined,
    total: typeof payload.contentLength === "number" ? payload.contentLength : undefined,
  };
}

export function useElectronUpdaterState(options: UseElectronUpdaterStateOptions) {
  const {
    releaseChannel,
    onReleaseChannelChange,
    updateAutoCheck,
    updateAutoDownload,
    setError,
  } = options;
  const [updateStatus, setUpdateStatus] = useState<SettingsUpdateStatus>(null);
  const [envState, dispatchEnvState] = useReducer(electronUpdaterEnvReducer, {
    appVersion: null,
    updateEnv: isElectronRuntime()
      ? null
      : { supported: false, reason: ELECTRON_UPDATER_UNSUPPORTED_REASON },
  });
  const { appVersion, updateEnv } = envState;
  const updateStatusRef = useRef(updateStatus);
  updateStatusRef.current = updateStatus;
  const lastAutoCheckAtRef = useRef(0);
  const autoCheckInFlightRef = useRef(false);
  const autoCheckKeyRef = useRef<string | null>(null);
  const checkRequestRef = useRef(0);
  const readyCheckInFlightRef = useRef<number | null>(null);
  const readyCheckCooldownRef = useRef(0);
  const stagedUpdateRevisionRef = useRef(0);
  const releaseChannelRequestRef = useRef(0);
  const availableReleaseChannelRef = useRef<ReleaseChannel | null>(null);
  const downloadedReleaseChannelRef = useRef<ReleaseChannel | null>(null);
  useEffect(() => {
    if (!isElectronRuntime()) {
      dispatchEnvState({ type: "unsupported", reason: ELECTRON_UPDATER_UNSUPPORTED_REASON });
      return;
    }
    const bridge = electronUpdaterBridge();
    if (!bridge?.getChannel) {
      dispatchEnvState({ type: "unsupported", reason: ELECTRON_UPDATER_UNSUPPORTED_REASON });
      return;
    }
    let cancelled = false;
    void bridge
      .getChannel()
      .then(async (state) => {
        if (cancelled) return;
        dispatchEnvState({ type: "app-version", appVersion: state.currentVersion ?? null });
        if (state.channel && state.channel !== releaseChannel && bridge.setChannel) {
          const nextState = await bridge.setChannel(releaseChannel);
          if (cancelled) return;
          dispatchEnvState({ type: "app-version", appVersion: nextState.currentVersion ?? null });
          if (nextState.channel && nextState.channel !== releaseChannel) {
            onReleaseChannelChange(nextState.channel);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          dispatchEnvState({ type: "unsupported", reason: ELECTRON_UPDATER_UNSUPPORTED_REASON });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onReleaseChannelChange, releaseChannel]);

  const downloadUpdate = useCallback(async (channelOverride?: ReleaseChannel) => {
    const status = updateStatusRef.current;
    if (!channelOverride && (status?.state === "downloading" || (status?.state === "ready" && readyCheckInFlightRef.current === checkRequestRef.current))) return;
    const candidate = !channelOverride && status?.state === "ready" ? status.candidate : undefined;
    if (candidate) {
      stagedUpdateRevisionRef.current += 1;
      checkRequestRef.current += 1;
      downloadedReleaseChannelRef.current = null;
      availableReleaseChannelRef.current = candidate.channel;
      const nextStatus: SettingsUpdateStatus = {
        state: "downloading",
        version: candidate.version,
        totalBytes: candidate.totalBytes,
        date: candidate.date,
        notes: candidate.notes,
        downloadedBytes: 0,
      };
      updateStatusRef.current = nextStatus;
      setUpdateStatus(nextStatus);
    }
    const releaseChannelRequestId = releaseChannelRequestRef.current;
    const isCurrentReleaseChannel = () =>
      releaseChannelRequestRef.current === releaseChannelRequestId;
    const bridge = electronUpdaterBridge();
    if (!bridge?.download) {
      const message = "Electron updater downloads are available only in the Electron desktop app.";
      setUpdateStatus({ state: "error", message, failedAction: "download" });
      setError(message);
      return;
    }

    const requestedReleaseChannel =
      channelOverride ??
      availableReleaseChannelRef.current ??
      releaseChannel;
    const activeReleaseChannel = requestedReleaseChannel;

    // Subscribe to incremental progress events from the main process so
    // the UI updates in real time instead of staying stuck at 0 bytes.
    let unsubProgress: (() => void) | null = null;
    if (bridge.onDownloadProgress) {
      unsubProgress = bridge.onDownloadProgress((data) => {
        if (!isCurrentReleaseChannel()) return;
        setUpdateStatus((current) => ({
          ...(current ?? {}),
          state: "downloading",
          downloadedBytes: data.transferred ?? 0,
          totalBytes: data.total ?? current?.totalBytes ?? null,
        }));
      });
    }

    if (!isCurrentReleaseChannel()) return;
    setUpdateStatus((current) => ({
      ...(current ?? {}),
      state: "downloading",
      downloadedBytes: current?.downloadedBytes ?? 0,
      totalBytes: current?.totalBytes ?? null,
    }));
    try {
      const result = await bridge.download();
      if (!isCurrentReleaseChannel()) return;
      if (!result?.ok) {
        const message = result?.reason ?? "Update download failed.";
        setUpdateStatus({
          state: "error",
          message,
          failedAction: "download",
        });
        setError(message);
        return;
      }
      availableReleaseChannelRef.current = null;
      downloadedReleaseChannelRef.current = activeReleaseChannel;
      // An install waiting on this download reads readiness before the next render.
      if (updateStatusRef.current) updateStatusRef.current = { ...updateStatusRef.current, state: "ready" };
      setUpdateStatus((current) => ({
        ...(current ?? {}),
        state: "ready",
      }));
    } catch (error) {
      if (!isCurrentReleaseChannel()) return;
      const message = describeError(error);
      setUpdateStatus({
        state: "error",
        message,
        failedAction: "download",
      });
      setError(message);
    } finally {
      unsubProgress?.();
    }
  }, [
    onReleaseChannelChange,
    releaseChannel,
    setError,
  ]);

  const runCheckForUpdates = useCallback(async (
    channelOverride?: ReleaseChannel,
    manual = false,
    suppressAutoDownload = false,
  ) => {
    if (!isElectronRuntime()) return;
    const requestId = checkRequestRef.current + 1;
    checkRequestRef.current = requestId;
    const isCurrentRequest = () => checkRequestRef.current === requestId;
    const requestedReleaseChannel = channelOverride ?? releaseChannel;
    const bridge = electronUpdaterBridge();
    if (!bridge?.check) {
      const message = "Electron update checks are available only in the Electron desktop app.";
      setUpdateStatus({ state: "error", message, failedAction: "check" });
      setError(message);
      return;
    }

    setUpdateStatus({ state: "checking" });
    try {
      const result = await bridge.check(requestedReleaseChannel);
      if (!isCurrentRequest()) return;
      dispatchEnvState({ type: "app-version", appVersion: result.currentVersion ?? null });
      const checkedReleaseChannel = result.channel ?? requestedReleaseChannel;
      if (result.reason === "unavailable") {
        setUpdateStatus({
          state: "idle",
          message: "Auto-updates are available in packaged builds only.",
        });
        return;
      }
      if (result.reason) {
        setUpdateStatus({
          state: "error",
          message: result.reason,
          failedAction: "check",
        });
        return;
      }
      const available = result.available;
      if (!isCurrentRequest()) return;
      const checkedUpdateState = result.available ? "available" : "idle";
      const nextStatus: Exclude<SettingsUpdateStatus, null> = {
        state: checkedUpdateState,
        lastCheckedAt: Date.now(),
        version: result.latestVersion ?? undefined,
        date: result.releaseDate ?? undefined,
        notes: releaseNotesToText(result.releaseNotes),
      };
      availableReleaseChannelRef.current = available
        ? checkedReleaseChannel
        : null;
      downloadedReleaseChannelRef.current = null;
      setUpdateStatus(nextStatus);
      if (available && updateAutoDownload && !suppressAutoDownload) {
        await downloadUpdate(checkedReleaseChannel);
      }
    } catch (error) {
      if (!isCurrentRequest()) return;
      setUpdateStatus({
        state: "error",
        message: describeError(error),
        failedAction: "check",
      });
    }
  }, [downloadUpdate, releaseChannel, setError, updateAutoDownload]);

  // Ask the feed whether an build newer than the staged one has shipped,
  // without disturbing the staged download. Resolves null once superseded.
  const findNewerThanStaged = useCallback(async (
    stagedVersion: string | undefined,
    isCurrentRequest: () => boolean,
  ): Promise<{ lost: true } | { lost: false; newest: boolean; candidate?: NonNullable<Exclude<SettingsUpdateStatus, null>["candidate"]> } | null> => {
    const bridge = electronUpdaterBridge();
    if (!bridge?.check) throw new Error(t("updates.bridge_unavailable"));
    const channel = downloadedReleaseChannelRef.current ?? releaseChannel;
    const result = await bridge.check(channel, undefined, { preserveStaged: true });
    if (!isCurrentRequest()) return null;
    if (!stagedVersion || result.stagedVersion !== stagedVersion) return { lost: true };
    if (result.reason) throw new Error(result.reason);
    const comparison = result.latestVersion
      ? compareVersions(result.latestVersion, stagedVersion)
      : null;
    const newerAvailable = result.available && result.latestVersion && comparison === 1;
    if (!isCurrentRequest()) return null;
    return {
      lost: false,
      newest: comparison === 0,
      candidate: newerAvailable && result.latestVersion ? {
        version: result.latestVersion,
        totalBytes: result.totalBytes ?? null,
        date: result.releaseDate ?? undefined,
        notes: releaseNotesToText(result.releaseNotes),
        channel,
      } : undefined,
    };
  }, [releaseChannel]);

  const markStagedUpdateLost = useCallback(() => {
    stagedUpdateRevisionRef.current += 1;
    downloadedReleaseChannelRef.current = null;
    availableReleaseChannelRef.current = null;
    readyCheckCooldownRef.current = 0;
    const message = t("updates.staged_unavailable");
    const nextStatus: SettingsUpdateStatus = { state: "error", failedAction: "check", message, checkError: message };
    updateStatusRef.current = nextStatus;
    setUpdateStatus(nextStatus);
  }, []);

  const checkWhileReady = useCallback(async () => {
    const staged = updateStatusRef.current;
    if (staged?.state !== "ready" || readyCheckInFlightRef.current === checkRequestRef.current || Date.now() < readyCheckCooldownRef.current) return;
    readyCheckCooldownRef.current = Date.now() + 15_000;
    const requestId = ++checkRequestRef.current;
    readyCheckInFlightRef.current = requestId;
    const isCurrentRequest = () => checkRequestRef.current === requestId &&
      updateStatusRef.current?.state === "ready" && updateStatusRef.current.version === staged.version;
    setUpdateStatus({
      ...staged,
      checkingForNewer: true,
      checkError: undefined,
      candidate: undefined,
      newest: false,
      checkCooldownUntil: readyCheckCooldownRef.current,
    });
    try {
      const found = await findNewerThanStaged(staged.version, isCurrentRequest);
      if (!found) return;
      if (found.lost) {
        markStagedUpdateLost();
        return;
      }
      setUpdateStatus({
        ...staged,
        checkingForNewer: false,
        checkError: undefined,
        checkCooldownUntil: readyCheckCooldownRef.current > Date.now() ? readyCheckCooldownRef.current : undefined,
        newest: found.newest,
        candidate: found.candidate,
      });
    } catch (error) {
      if (!isCurrentRequest()) return;
      readyCheckCooldownRef.current = 0;
      setUpdateStatus({
        ...staged,
        checkingForNewer: false,
        checkError: describeError(error),
        checkCooldownUntil: undefined,
        newest: false,
        candidate: undefined,
      });
    } finally {
      if (readyCheckInFlightRef.current === requestId) readyCheckInFlightRef.current = null;
    }
  }, [findNewerThanStaged, markStagedUpdateLost]);

  // A release can ship after an update was downloaded. Replace the staged build
  // with the newest one so a single restart lands on it, instead of a
  // second "Restart to update" right after the first. A failed lookup keeps the
  // staged build; at install time so does an unconfirmed stage, which the
  // install's own update-not-downloaded recovery handles. Resolves whether an
  // update is still ready to install.
  const refreshStagedUpdate = useCallback(async (mode: "background" | "install") => {
    const staged = updateStatusRef.current;
    if (staged?.state !== "ready") return false;
    if (readyCheckInFlightRef.current !== null) return true;
    const requestId = ++checkRequestRef.current;
    readyCheckInFlightRef.current = requestId;
    const isCurrentRequest = () => checkRequestRef.current === requestId &&
      updateStatusRef.current?.state === "ready" && updateStatusRef.current.version === staged.version;
    let candidate = false;
    try {
      const found = await findNewerThanStaged(staged.version, isCurrentRequest);
      if (!found) return updateStatusRef.current?.state === "ready";
      if (found.lost) {
        if (mode === "install") return true;
        markStagedUpdateLost();
        return false;
      }
      if (mode === "install" && !found.candidate) return true;
      const nextStatus: SettingsUpdateStatus = {
        ...updateStatusRef.current,
        state: "ready",
        checkError: undefined,
        newest: found.newest,
        candidate: found.candidate,
      };
      updateStatusRef.current = nextStatus;
      setUpdateStatus(nextStatus);
      candidate = Boolean(found.candidate);
    } catch {
      return updateStatusRef.current?.state === "ready";
    } finally {
      if (readyCheckInFlightRef.current === requestId) readyCheckInFlightRef.current = null;
    }
    if (candidate && (mode === "install" || updateAutoDownload)) await downloadUpdate();
    return updateStatusRef.current?.state === "ready";
  }, [downloadUpdate, findNewerThanStaged, markStagedUpdateLost, updateAutoDownload]);

  const checkCooldownUntil = updateStatus?.checkCooldownUntil;
  useEffect(() => {
    if (!checkCooldownUntil) {
      readyCheckCooldownRef.current = 0;
      return;
    }
    const timer = window.setTimeout(() => {
      setUpdateStatus((current) => current?.checkCooldownUntil === checkCooldownUntil
        ? { ...current, checkCooldownUntil: undefined }
        : current);
    }, Math.max(0, checkCooldownUntil - Date.now()));
    return () => window.clearTimeout(timer);
  }, [checkCooldownUntil]);

  const checkForUpdates = useCallback(
    (channelOverride?: ReleaseChannel) => {
      const status = updateStatusRef.current;
      const state = status?.state;
      if (!channelOverride && state === "ready") return checkWhileReady();
      if (!channelOverride && state === "downloading") return Promise.resolve();
      return runCheckForUpdates(channelOverride, true, !channelOverride && Boolean(status?.checkError));
    },
    [checkWhileReady, runCheckForUpdates],
  );

  useEffect(() => {
    if (!updateAutoCheck || updateEnv?.supported === false || !appVersion) return;
    const key = `${releaseChannel}:${appVersion}`;
    const interval = 15 * 60 * 1000;
    const check = () => {
      const status = updateStatusRef.current;
      const state = status?.state;
      if (autoCheckInFlightRef.current || state === "checking" || state === "downloading") return;
      if (state !== "ready" && status?.checkError) return;
      // A failed install needs the person: the update was already downloaded,
      // so a background re-check would only re-download it and re-offer the
      // same restart. Keep the failure (and Settings' Check now) until they retry.
      if (status?.state === "error" && status.failedAction === "install") return;
      if (autoCheckKeyRef.current === key && Date.now() - lastAutoCheckAtRef.current < interval) return;
      autoCheckKeyRef.current = key;
      lastAutoCheckAtRef.current = Date.now();
      autoCheckInFlightRef.current = true;
      const run = state === "ready"
        ? refreshStagedUpdate("background")
        : runCheckForUpdates(undefined, false);
      void run.finally(() => {
        autoCheckInFlightRef.current = false;
      });
    };
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    check();
    const timer = window.setInterval(check, interval);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [appVersion, releaseChannel, refreshStagedUpdate, runCheckForUpdates, updateAutoCheck, updateEnv?.supported]);

  // Run a check when the native "Check for Updates..." menu item was used.
  // Requests use the local release feed and the user's selected channel.
  const updateCheckRequestedAt = useUpdateCheckRequestStore((state) => state.requestedAt);
  useEffect(() => {
    if (updateCheckRequestedAt == null || updateEnv?.supported === false) return;
    useUpdateCheckRequestStore.getState().clearUpdateCheckRequest();
    void checkForUpdates();
  }, [checkForUpdates, updateCheckRequestedAt, updateEnv?.supported]);

  const installUpdateAndRestart = useCallback(async () => {
    // Restart onto the newest build, fetching it first if one shipped
    // after the staged download.
    if (!(await refreshStagedUpdate("install"))) return;
    const releaseChannelRequestId = releaseChannelRequestRef.current;
    const stagedUpdateRevision = stagedUpdateRevisionRef.current;
    const isCurrentReleaseChannel = () =>
      releaseChannelRequestRef.current === releaseChannelRequestId &&
      stagedUpdateRevisionRef.current === stagedUpdateRevision;
    const bridge = electronUpdaterBridge();
    if (!bridge?.installAndRestart) {
      const message = "Electron update install is available only in the Electron desktop app.";
      setUpdateStatus({ state: "error", message, failedAction: "install" });
      setError(message);
      return;
    }
    try {
      const result = await bridge.installAndRestart();
      if (!isCurrentReleaseChannel()) return;
      if (!result?.ok) {
        const message = result?.reason ?? "Update install failed.";
        setError(message);
        if (result?.reason === "update-not-downloaded") {
          // The main-side staged download was invalidated; re-check so the UI
          // returns to a working stable-targeted download/install flow.
          downloadedReleaseChannelRef.current = null;
          availableReleaseChannelRef.current = null;
          await runCheckForUpdates(undefined, true);
          return;
        }
        setUpdateStatus({
          state: "error",
          message,
          failedAction: "install",
        });
      }
    } catch (error) {
      if (!isCurrentReleaseChannel()) return;
      const message = describeError(error);
      setUpdateStatus({
        state: "error",
        message,
        failedAction: "install",
      });
      setError(message);
    }
  }, [refreshStagedUpdate, runCheckForUpdates, setError]);

  const setReleaseChannel = useCallback(
    async (next: ReleaseChannel) => {
      const requestId = releaseChannelRequestRef.current + 1;
      releaseChannelRequestRef.current = requestId;
      checkRequestRef.current += 1;
      const bridge = electronUpdaterBridge();
      try {
        const selectedReleaseChannel = next;
        onReleaseChannelChange(selectedReleaseChannel);
        if (!bridge?.setChannel) return;
        const state = await bridge.setChannel(selectedReleaseChannel);
        if (releaseChannelRequestRef.current !== requestId) return;
        dispatchEnvState({ type: "app-version", appVersion: state.currentVersion ?? null });
        if (state.channel && state.channel !== selectedReleaseChannel) {
          onReleaseChannelChange(state.channel);
        }
        await checkForUpdates(state.channel ?? selectedReleaseChannel);
      } catch (error) {
        if (releaseChannelRequestRef.current !== requestId) return;
        setUpdateStatus({
          state: "error",
          message: describeError(error),
          failedAction: "check",
        });
      }
    },
    [checkForUpdates, onReleaseChannelChange],
  );

  return {
    appVersion,
    updateEnv,
    updateStatus,
    checkForUpdates,
    downloadUpdate,
    installUpdateAndRestart,
    setReleaseChannel,
  };
}
