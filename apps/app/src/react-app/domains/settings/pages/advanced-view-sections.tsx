/** @jsxImportSource react */
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { Cpu, RefreshCcw, Server } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { OpenworkServerClient, OpenworkRuntimeConfigStatus } from "@/app/lib/openwork-server";
import { sanitizeDiagnosticRecord } from "@/app/lib/diagnostic-sanitizer";
import { useOpencodeEngineControls } from "@/react-app/shell/opencode-engine-controls";
import { desktopBridge } from "@/app/lib/desktop";
import { isDesktopRuntime, isElectronRuntime, isMacPlatform } from "@/app/utils";
import { useDesktopFeature } from "../../session/status/use-desktop-feature";
import { t } from "@/i18n";
import { usePlatform } from "../../../kernel/platform";
import { useFeatureFlagsPreferences } from "../state/feature-flags-preferences";
import {
  SettingsInset,
  SettingsNotice,
  SettingsStatusBadge,
} from "../settings-section";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemFootnote,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
} from "../settings-layout";

type SettingsTone = ComponentProps<typeof SettingsStatusBadge>["tone"];

interface RuntimeStatusCardProps {
  icon: ReactNode;
  title: string;
  description: string;
  statusLabel: string;
  tone: SettingsTone;
  detailLines?: string[];
}

function RuntimeStatusCard(props: RuntimeStatusCardProps) {
  return (
    <SettingsInset className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-gray-6/60 bg-gray-1/70 text-gray-12">
          {props.icon}
        </div>
        <div>
          <div className="text-sm font-medium text-gray-12">{props.title}</div>
          <div className="text-xs text-gray-9">{props.description}</div>
        </div>
      </div>
      <SettingsStatusBadge className="inline-flex min-h-0 justify-start px-0 py-0" tone={props.tone} label={props.statusLabel} />
      {props.detailLines?.length ? (
        <div className="space-y-1 border-t border-gray-6/50 pt-2 text-[11px] text-gray-9">
          {props.detailLines.map((line) => (
            <div key={line} className="truncate" title={line}>
              {line}
            </div>
          ))}
        </div>
      ) : null}
    </SettingsInset>
  );
}

interface AdvancedRuntimeSectionProps {
  clientStatusLabel: string;
  clientTone: SettingsTone;
  clientDetailLines: string[];
  openworkStatusLabel: string;
  openworkTone: SettingsTone;
  openworkDetailLines: string[];
}

export function AdvancedRuntimeSection(props: AdvancedRuntimeSectionProps) {
  return (
    <LayoutSection id="advanced-runtime">
      <LayoutSectionHeader>
        <LayoutSectionTitle>{t("settings.runtime_title")}</LayoutSectionTitle>
        <LayoutSectionDescription>{t("settings.runtime_desc")}</LayoutSectionDescription>
      </LayoutSectionHeader>

      <div className="grid gap-3 sm:grid-cols-2">
        <RuntimeStatusCard
          icon={<Cpu size={18} />}
          title={t("settings.opencode_engine_label")}
          description={t("settings.opencode_engine_desc")}
          statusLabel={props.clientStatusLabel}
          tone={props.clientTone}
          detailLines={props.clientDetailLines}
        />
        <RuntimeStatusCard
          icon={<Server size={18} />}
          title={t("settings.openwork_server_label")}
          description={t("settings.openwork_server_desc")}
          statusLabel={props.openworkStatusLabel}
          tone={props.openworkTone}
          detailLines={props.openworkDetailLines}
        />
      </div>
    </LayoutSection>
  );
}

interface AdvancedRuntimeConfigSourcesSectionProps {
  busy: boolean;
  canInspect: boolean;
  configStatus: OpenworkRuntimeConfigStatus | null;
  configStatusBusy: boolean;
  configStatusError: string | null;
  onRefresh: () => Promise<void>;
}

function formatKeys(keys: string[]) {
  return keys.length ? keys.join(", ") : "none";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizedConfig(config: Record<string, unknown>): Record<string, unknown> {
  return sanitizeDiagnosticRecord(config);
}

function countRecord(value: unknown) {
  return isRecord(value) ? Object.keys(value).length : 0;
}

function countArray(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function providerModelCount(config: Record<string, unknown>) {
  const providers = isRecord(config.provider) ? config.provider : {};
  return Object.values(providers).reduce<number>((total, provider) => {
    if (!isRecord(provider)) return total;
    return total + countRecord(provider.models);
  }, 0);
}

function RuntimeConfigSummary(props: { config: Record<string, unknown> }) {
  const config = props.config;
  const providers = countRecord(config.provider);
  const models = providerModelCount(config);
  const agents = countRecord(config.agent);
  const plugins = countArray(config.plugin);
  const mcps = countRecord(config.mcp);
  const permissions = countRecord(config.permission);
  const disabledProviders = countArray(config.disabled_providers);
  const defaultAgent = typeof config.default_agent === "string" ? config.default_agent : "not set";

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <div className="rounded-lg border border-gray-6 bg-gray-2/60 p-2">
        <div className="text-[10px] uppercase tracking-wide text-gray-8">Default agent</div>
        <div className="mt-1 truncate font-mono text-[11px] text-gray-12" title={defaultAgent}>{defaultAgent}</div>
      </div>
      <div className="rounded-lg border border-gray-6 bg-gray-2/60 p-2">
        <div className="text-[10px] uppercase tracking-wide text-gray-8">Providers / models</div>
        <div className="mt-1 font-mono text-[11px] text-gray-12">{providers} providers, {models} models</div>
      </div>
      <div className="rounded-lg border border-gray-6 bg-gray-2/60 p-2">
        <div className="text-[10px] uppercase tracking-wide text-gray-8">Agents / plugins</div>
        <div className="mt-1 font-mono text-[11px] text-gray-12">{agents} agents, {plugins} plugins</div>
      </div>
      <div className="rounded-lg border border-gray-6 bg-gray-2/60 p-2">
        <div className="text-[10px] uppercase tracking-wide text-gray-8">MCP / permissions</div>
        <div className="mt-1 font-mono text-[11px] text-gray-12">{mcps} MCPs, {permissions} permission keys</div>
      </div>
      {disabledProviders ? (
        <div className="rounded-lg border border-gray-6 bg-gray-2/60 p-2 sm:col-span-2 lg:col-span-4">
          <div className="text-[10px] uppercase tracking-wide text-gray-8">Disabled providers</div>
          <div className="mt-1 font-mono text-[11px] text-gray-12">{disabledProviders}</div>
        </div>
      ) : null}
    </div>
  );
}

function RuntimeConfigSourceBlock(props: {
  title: string;
  description: string;
  path?: string;
  exists?: boolean;
  keys: string[];
  config: Record<string, unknown>;
}) {
  const safeConfig = sanitizedConfig(props.config);
  return (
    <div className="space-y-2 rounded-xl border border-gray-6 bg-gray-1/70 p-3">
      <div>
        <div className="font-medium text-gray-12">{props.title}</div>
        <div className="text-[11px] text-gray-9">{props.description}</div>
        {props.path ? <div className="mt-1 break-all font-mono text-[11px] text-gray-8">{props.path}</div> : null}
        {props.exists !== undefined ? <div className="text-[11px] text-gray-9">{props.exists ? "Found" : "Not found"}</div> : null}
        <div className="text-[11px] text-gray-9">Keys: {formatKeys(props.keys)}</div>
      </div>
      <RuntimeConfigSummary config={safeConfig} />
      <details className="rounded-lg bg-gray-3 p-2">
        <summary className="cursor-pointer text-[11px] font-medium text-gray-11">Show raw JSON</summary>
        <pre className="mt-2 max-h-56 overflow-auto font-mono text-[11px] text-gray-11">
          {JSON.stringify(safeConfig, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function AdvancedRuntimeConfigSourcesSection(props: AdvancedRuntimeConfigSourcesSectionProps) {
  const effectiveRuntimeConfig = props.configStatus
    ? sanitizedConfig(props.configStatus.effectiveRuntime ?? props.configStatus.runtime)
    : null;
  const runtimeConfig = props.configStatus ? sanitizedConfig(props.configStatus.runtime) : null;
  return (
    <LayoutSection id="advanced-config-sources">
      <LayoutSectionHeader>
        <LayoutSectionTitle>OpenCode config sources</LayoutSectionTitle>
        <LayoutSectionDescription>
          Inspect what OpenWork controls at runtime versus what belongs to your workspace config. This works through the OpenWork server and does not require the OpenCode engine to be healthy.
        </LayoutSectionDescription>
      </LayoutSectionHeader>

      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>Config source snapshot</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>
            Shows the OpenWork runtime database, the injected runtime config, and the workspace-owned OpenCode config files.
          </LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void props.onRefresh()}
              disabled={props.busy || props.configStatusBusy || !props.canInspect}
            >
              <RefreshCcw size={14} className={props.configStatusBusy ? "animate-spin" : ""} />
              Refresh
            </Button>
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
        {props.configStatusError ? <SettingsNotice>{props.configStatusError}</SettingsNotice> : null}
        {props.configStatus ? (
          <div className="space-y-3 rounded-xl border border-gray-6 bg-gray-1/60 p-3 text-xs text-gray-10">
            <div className="space-y-2 rounded-xl border border-blue-6/50 bg-blue-2/40 p-3">
              <div className="font-medium text-gray-12">Desired OpenWork runtime config</div>
              <div className="text-[11px] text-gray-9">
                This is the OpenWork-built config object requested for the runtime database and injected safely by the server. Sensitive headers are redacted here.
              </div>
              <RuntimeConfigSummary config={effectiveRuntimeConfig ?? {}} />
              <details className="rounded-lg bg-gray-3 p-2">
                <summary className="cursor-pointer text-[11px] font-medium text-gray-11">Show desired JSON</summary>
                <pre className="mt-2 max-h-72 overflow-auto font-mono text-[11px] text-gray-11">
                  {JSON.stringify(effectiveRuntimeConfig, null, 2)}
                </pre>
              </details>
            </div>
            {props.configStatus.sources ? (
              <div className="space-y-3">
                <div>
                  <div className="font-medium text-gray-12">OpenCode source breakdown</div>
                  <div className="text-[11px] text-gray-9">
                    OpenCode also reads its own project and global config files. OpenWork injects the runtime config separately; for OpenWork-managed keys, the injected config is the source to inspect.
                  </div>
                </div>
                <RuntimeConfigSourceBlock
                  title="Project opencode config"
                  description="Workspace-level OpenCode config owned by the user/project."
                  path={props.configStatus.sources.projectOpencode.path}
                  exists={props.configStatus.sources.projectOpencode.exists}
                  keys={props.configStatus.sources.projectOpencode.keys}
                  config={props.configStatus.sources.projectOpencode.config}
                />
                <RuntimeConfigSourceBlock
                  title="Global opencode config"
                  description="User-level OpenCode config under ~/.config/opencode."
                  path={props.configStatus.sources.globalOpencode.path}
                  exists={props.configStatus.sources.globalOpencode.exists}
                  keys={props.configStatus.sources.globalOpencode.keys}
                  config={props.configStatus.sources.globalOpencode.config}
                />
                <RuntimeConfigSourceBlock
                  title="OpenWork runtime DB"
                  description="OpenWork-managed runtime values stored outside workspace files."
                  keys={props.configStatus.sources.runtimeDatabase.keys}
                  config={props.configStatus.sources.runtimeDatabase.config}
                />
                <RuntimeConfigSourceBlock
                  title="OpenWork injected config"
                  description="The object OpenWork injects into OpenCode at runtime."
                  keys={props.configStatus.sources.injected.keys}
                  config={props.configStatus.sources.injected.config}
                />
              </div>
            ) : null}
            <div>
              <div className="font-medium text-gray-12">Runtime database</div>
              <div>Stored keys: {formatKeys(props.configStatus.runtimeKeys)}</div>
            </div>
            <div>
              <div className="font-medium text-gray-12">User opencode.jsonc</div>
              <div className="break-all">{props.configStatus.userOpencode.path}</div>
              <div>{props.configStatus.userOpencode.exists ? "Found" : "Not found"}</div>
              <div>User-owned keys: {formatKeys(props.configStatus.userOpencode.keys)}</div>
            </div>
            <div>
              <div className="font-medium text-gray-12">Runtime DB JSON</div>
              <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-gray-3 p-2 font-mono text-[11px] text-gray-11">
                {JSON.stringify(runtimeConfig, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}
      </LayoutSectionItem>
    </LayoutSection>
  );
}

export function AdvancedWorkspaceRunModeSection() {
  const { workspaceRunModeEnabled, toggleWorkspaceRunMode } = useFeatureFlagsPreferences();
  return (
    <LayoutSection id="advanced-workspace-run-mode">
      <LayoutSectionHeader>
        <LayoutSectionTitle>Workspace run mode</LayoutSectionTitle>
        <LayoutSectionDescription>Experimental approval controls in the composer.</LayoutSectionDescription>
      </LayoutSectionHeader>
      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>Show workspace run mode</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>
            Choose when OpenWork asks before acting, using the icon beside attachments. Off by default. Available with the standard desktop engine.
          </LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            <Switch
              data-testid="workspace-run-mode-flag"
              aria-label="Show workspace run mode"
              checked={workspaceRunModeEnabled}
              disabled={!isDesktopRuntime()}
              onCheckedChange={toggleWorkspaceRunMode}
            />
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
        <LayoutSectionItemFootnote>
          This switch only shows or hides the control. Hiding it does not reset workspace permissions; choose Workspace defaults in the menu first if you want to remove the override.
        </LayoutSectionItemFootnote>
      </LayoutSectionItem>
    </LayoutSection>
  );
}

export function AdvancedEngineV2PreviewSection(props: { client: OpenworkServerClient | null }) {
  const engine = useOpencodeEngineControls(props.client);
  if (!isDesktopRuntime()) return null;
  const runtimeError = engine.status?.enabled ? engine.status.lastError : undefined;
  const engineNote = engine.blockedReason ?? engine.v1Locked;
  return (
    <LayoutSection id="advanced-experimental-engine">
      <LayoutSectionHeader><LayoutSectionTitle>OpenCode engine</LayoutSectionTitle></LayoutSectionHeader>
      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>Chat engine</LayoutSectionItemTitle>
          <LayoutSectionItemHeaderActions>
            <ToggleGroup aria-label="Chat engine" value={[engine.selected]} variant="outline" disabled={engine.disabled}
              onValueChange={(value) => { if (value[0] === "v1" || value[0] === "v2") engine.select(value[0]); }}>
              <ToggleGroupItem value="v1" data-engine="v1" disabled={Boolean(engine.v1Locked)}>OpenCode v1</ToggleGroupItem>
              <ToggleGroupItem value="v2" data-engine="v2">OpenCode v2 (preview)</ToggleGroupItem>
            </ToggleGroup>
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
        {engineNote ? <p className="text-xs text-muted-foreground">{engineNote}</p> : null}
        {engine.status?.enabled && !engine.status.running && !engine.status.lastError ? <p role="status" className="text-xs text-muted-foreground">OpenCode v2 is starting…</p> : null}
        {engine.error || runtimeError ? <p role="alert" className="text-xs text-destructive">{engine.error ?? runtimeError}</p> : null}
      </LayoutSectionItem>
      <details className="text-xs text-muted-foreground"><summary>Engine details</summary>
        {engine.status?.running ? <p>OpenCode {engine.status.version} · {engine.status.mirroredProviderIds.length} providers · {engine.status.catalogModelIds.length} models</p> : null}
      </details>
    </LayoutSection>
  );
}

interface AdvancedDeveloperSectionProps {
  busy: boolean;
  developerMode: boolean;
  opencodeDevModeEnabled: boolean;
  deepLinkOpen: boolean;
  deepLinkInput: string;
  deepLinkBusy: boolean;
  deepLinkStatus: string | null;
  onToggleDeveloperMode: () => void;
  onToggleDeepLink: () => void;
  onDeepLinkInput: (input: string) => void;
  onSubmitDeepLink: () => Promise<void>;
}

export function AdvancedDeveloperSection(props: AdvancedDeveloperSectionProps) {
  return (
    <LayoutSection id="advanced-developer">
      <LayoutSectionHeader>
        <LayoutSectionTitle>{t("settings.developer")}</LayoutSectionTitle>
      </LayoutSectionHeader>

      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>{t("settings.developer_mode_title")}</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>{t("settings.developer_mode_desc")}</LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            <Switch
              aria-label={t("settings.developer_mode_title")}
              checked={props.developerMode}
              onCheckedChange={props.onToggleDeveloperMode}
            />
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
      </LayoutSectionItem>

      <ComputerUseRecordingItem />

      {isDesktopRuntime() && props.opencodeDevModeEnabled && props.developerMode ? (
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.open_deeplink_title")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.open_deeplink_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={props.onToggleDeepLink}
                disabled={props.busy || props.deepLinkBusy}
              >
                {props.deepLinkOpen ? t("common.hide") : t("settings.open_deeplink_button")}
              </Button>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>

          {props.deepLinkOpen ? (
            <div className="space-y-3">
              <Field>
                <FieldLabel htmlFor="advanced-debug-deep-link">{t("settings.open_deeplink_title")}</FieldLabel>
                <Textarea
                  id="advanced-debug-deep-link"
                  value={props.deepLinkInput}
                  onChange={(event) => props.onDeepLinkInput(event.currentTarget.value)}
                  rows={3}
                  placeholder="openwork://..."
                  className="font-mono text-xs"
                />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void props.onSubmitDeepLink()}
                  disabled={props.busy || props.deepLinkBusy || !props.deepLinkInput.trim()}
                >
                  {props.deepLinkBusy ? t("settings.opening") : t("settings.open_deeplink_action")}
                </Button>
                <div className="text-xs text-gray-8">{t("settings.deeplink_hint")}</div>
              </div>
            </div>
          ) : null}

          {props.deepLinkStatus ? <SettingsNotice>{props.deepLinkStatus}</SettingsNotice> : null}
        </LayoutSectionItem>
      ) : null}
    </LayoutSection>
  );
}

/**
 * Lets screen recordings show the agent's cursor, frame and pill on this Mac, for demos.
 * Main keeps the choice until OpenWork quits; it applies to the next app the agent starts using.
 */
function ComputerUseRecordingItem() {
  const shown = useDesktopFeature("computerUse") && isElectronRuntime() && isMacPlatform();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!shown) return;
    let current = true;
    desktopBridge.computerRecordableOverlay()
      .then((value) => { if (current) setEnabled(value); })
      .catch(() => { if (current) setEnabled(false); });
    return () => { current = false; };
  }, [shown]);

  if (!shown) return null;
  const change = (next: boolean) => {
    setError("");
    desktopBridge.computerSetRecordableOverlay(next)
      .then(setEnabled)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>Show computer use in screen recordings</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>
          The agent's cursor, frame and controls appear in screen recordings and screen sharing, for demos. Starts with the next app the agent uses and turns off when OpenWork quits. The agent's own screenshots never include them.
        </LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions>
          <Switch
            aria-label="Show computer use in screen recordings"
            data-testid="settings-computer-recordable-overlay"
            checked={enabled === true}
            disabled={enabled === null}
            onCheckedChange={change}
          />
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
      {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
    </LayoutSectionItem>
  );
}
