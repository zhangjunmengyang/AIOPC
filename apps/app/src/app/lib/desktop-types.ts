// Type definitions for the desktop bridge.
// The payload shapes and the per-command contract live in
// packages/types/src/desktop-ipc.ts (shared with the Electron main process);
// this module re-exports them as the app-side import path.

import type { WorkspaceWire } from "@openwork/types/workspace";

export type {
  AppBuildInfo,
  BrandIconApplyResult,
  BrandIconState,
  CacheResetResult,
  DesktopBootstrapConfig,
  DesktopDistributionInfo,
  DesktopIntegrationIssue,
  DesktopIntegrationResult,
  DesktopIntegrationStatus,
  DesktopCommandArgs,
  DesktopCommandInvokers,
  DesktopCommandMap,
  DesktopCommandName,
  DesktopCommandResult,
  DesktopBinaryDownloadResult,
  DesktopFetchInit,
  DesktopFetchResult,
  DesktopStartupTimings,
  EngineDoctorResult,
  EngineInfo,
  EvalRelaunchResult,
  ExecResult,
  LocalSkillCard,
  LocalSkillContent,
  NativeContextMenuItem,
  NativeContextMenuRequest,
  NukeManifestPreview,
  NukeOptions,
  NukeReceipt,
  NukeReceiptError,
  OpencodeCommandDraft,
  OpencodeConfigFile,
  OpencodeExecutionEnvEntry,
  OpencodeExecutionSnapshot,
  OpenworkDockerCleanupResult,
  OpenworkServerInfo,
  UpdaterEnvironment,
  WorkspaceCreateInput,
  WorkspaceExportSummary,
  WorkspaceList,
  WorkspaceOpenworkConfig,
} from "@openwork/types/desktop-ipc";

// Canonical wire shape shared with openwork-server and the desktop bridge.
// Single source of truth: packages/types/src/workspace.ts.
export type WorkspaceInfo = WorkspaceWire;
