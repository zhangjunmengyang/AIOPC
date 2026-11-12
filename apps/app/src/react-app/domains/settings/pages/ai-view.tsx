import type { ReactNode } from "react";
import { CLAUDE_AGENT_HOST_PROVIDER_ID, CLAUDE_AGENT_PROVIDER_ID, CLAUDE_CODE_NAME, claudeAgentConnected, claudeAgentProblem, type ClaudeAgentSetupState } from "@/app/lib/claude-agent";
import { Lock, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { isKeylessZenProvider } from "../../connections/provider-auth/provider-policy";
import type { ProviderLoadState } from "../../connections/provider-auth/store";
import { credentialHealthKey, useProviderCredentialHealth, type ProviderCredentialHealth } from "../../connections/provider-auth/credential-health";
import type { LocalProviderEngineState } from "../../connections/provider-auth/local-provider-engine-state";
import { SettingsNotice } from "../settings-section";
import { LayoutStack } from "../settings-layout";
import { SettingsPanel, SettingsPanelDescription, SettingsPanelHeading, SettingsPanelTitle } from "../shell/panel";
import { getSettingsTabLabel } from "../shell/settings-page";
import { CredentialHealthStatus, LocalProviderStatus, ProviderList, ProviderMeta, ProviderRow, ProviderStatus, ProviderTile } from "./provider-rows";

export type ConnectedProvider = {
  id: string;
  name: string;
  source?: "env" | "api" | "config" | "custom";
};

export type AiSettingsViewProps = {
  /** Claude Code sign-in; absent when the person cannot use it. Its row shows only once connected. */
  claudeAgent?: ClaudeAgentSetupState;
  /** Opens Connect a provider on the Claude Code step, to sign in again. */
  onOpenClaudeAgent?: () => void | Promise<void>;
  busy: boolean;
  runtimeWorkspaceId?: string | null;
  onReplaceProviderKey?: (providerId: string) => void | Promise<void>;
  providerAuthBusy: boolean;
  providerStatusLabel: string;
  providerStatusStyle: string;
  providerSummary: string;
  providerLoadState: ProviderLoadState;
  onRetryProviders: () => void | Promise<void>;
  connectedProviders: ConnectedProvider[];
  disconnectingProviderId: string | null;
  providerConnectError: string | null;
  providerDisconnectStatus: string | null;
  providerDisconnectError: string | null;
  onOpenProviderAuth: () => void | Promise<void>;
  onDisconnectProvider: (providerId: string) => void | Promise<void>;
  canDisconnectProvider: (provider: ConnectedProvider) => boolean;
  /** Providers hidden by Disconnect (disabled_providers); each can be enabled again. */
  disabledProviders?: { id: string; name: string }[];
  enablingProviderId?: string | null;
  onEnableProvider?: (providerId: string) => void | Promise<void>;
  canAddProviders: boolean;
  /** Providers on this device the engine chat runs on cannot use, from the server's skipped list. */
  localProviderStates?: ReadonlyMap<string, LocalProviderEngineState>;
};

function deviceSourceLabel(source: ConnectedProvider["source"]) {
  if (source === "api") return "API key";
  if (source === "env") return "Environment credential";
  return "Configured on this device";
}
export function aiProvidersDescription() { return "本项目可用的模型。添加的凭据保存在这台设备上。"; }

export function AiSettingsView(props: AiSettingsViewProps) {
  const healthEntries = useProviderCredentialHealth((state) => state.entries);
  const providerHealth = (providerId: string): ProviderCredentialHealth =>
    (props.runtimeWorkspaceId ? healthEntries[credentialHealthKey(props.runtimeWorkspaceId, providerId)]?.status : undefined) ?? "unverified";
  const ready = props.providerLoadState.status === "ready";
  const loading = props.providerLoadState.status === "loading" || props.providerLoadState.status === "idle";
  const error = props.providerLoadState.error;
  // Keyless built-in Zen is offered under "Available to add" in Connect a provider, not listed as connected.
  const local = props.connectedProviders.filter((provider) => provider.id !== CLAUDE_AGENT_PROVIDER_ID && !isKeylessZenProvider(provider));
  const disabled = props.onEnableProvider ? props.disabledProviders ?? [] : [];
  // AIOPC never offers OpenWork's hosted free models.
  const locked = !props.canAddProviders;
  const claudeConnected = claudeAgentConnected(props.claudeAgent);
  const claudeProblem = claudeAgentProblem(props.claudeAgent);
  const deviceCount = local.length + Number(claudeConnected);
  const rowsBusy = props.busy || props.providerAuthBusy || props.disconnectingProviderId !== null;
  const needsCredentialRecovery = (providerId: string) => providerHealth(providerId) === "rejected"
    && props.localProviderStates?.get(providerId) !== "not_on_engine";

  return <LayoutStack>
    <SettingsPanel>
      <SettingsPanelHeading className="max-w-xl">
        <SettingsPanelTitle>{getSettingsTabLabel("ai")}</SettingsPanelTitle>
        <SettingsPanelDescription>{aiProvidersDescription()}</SettingsPanelDescription>
      </SettingsPanelHeading>
      <Button className="shrink-0 self-start" disabled={locked || props.busy || props.providerAuthBusy || (!ready && !props.claudeAgent)} onClick={() => void props.onOpenProviderAuth()}>
        {locked ? <Lock className="size-4" /> : <Plus className="size-4" />}Connect a provider
      </Button>
    </SettingsPanel>


    {error ? <SettingsNotice tone="error" className="flex flex-wrap items-center justify-between gap-3"><div role="alert"><p>{props.claudeAgent ? "Other provider settings could not be loaded." : error}</p>{props.connectedProviders.length ? <p>{t("settings.providers_not_refreshed")}</p> : null}</div><Button variant="outline" disabled={props.busy || loading} aria-busy={loading} onClick={() => void props.onRetryProviders()}>{t("settings.providers_retry")}</Button></SettingsNotice> : null}

    <section className="flex flex-col gap-3" aria-labelledby="ai-providers-device">
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="ai-providers-device" className="text-base font-medium text-dls-text">On this device</h2>
          {ready ? <span className="text-xs text-muted-foreground">{deviceCount === 1 ? "1 provider" : `${deviceCount} providers`}</span> : null}
        </div>
        <p className="text-sm text-muted-foreground">无需 AIOPC 账号。使用你自己的服务商登录或 API Key。</p>
      </div>

      {loading && !props.connectedProviders.length ? <div role="status" aria-label={t("settings.loading_providers")} className="grid gap-2">{[0, 1].map((key) => <div key={key} className="h-16 animate-pulse rounded-2xl bg-muted" />)}</div> : null}

      {claudeConnected || local.length || disabled.length ? <ProviderList>
        {claudeConnected ? <ProviderRow
          testId="local-provider-claude-agent"
          scope="device"
          tile={<ProviderTile providerId={CLAUDE_AGENT_HOST_PROVIDER_ID} name={CLAUDE_CODE_NAME} />}
          name={CLAUDE_CODE_NAME}
          status={claudeProblem ? <ProviderStatus tone="attention">Needs your sign-in</ProviderStatus>
            : props.claudeAgent?.checking ? <ProviderStatus tone="neutral">Checking</ProviderStatus>
            : props.claudeAgent?.verified ? <ProviderStatus tone="ready">Ready to use</ProviderStatus>
            : <ProviderStatus tone="neutral">Not checked yet</ProviderStatus>}
          meta={<ProviderMeta id={CLAUDE_AGENT_PROVIDER_ID} parts={[claudeProblem ? claudeProblem.message : "Claude Code login"]} />}
          actions={<>
            {claudeProblem ? <Button disabled={rowsBusy || props.claudeAgent?.busy || !props.onOpenClaudeAgent} onClick={() => void props.onOpenClaudeAgent?.()}>Sign in again</Button> : null}
            <Button variant="ghost" disabled={rowsBusy || props.claudeAgent?.busy} onClick={() => void Promise.resolve(props.onDisconnectProvider(CLAUDE_AGENT_PROVIDER_ID)).catch(() => undefined)}>{t("settings.disconnect")}</Button>
          </>}
        /> : null}

        {local.map((provider) => <ProviderRow
          key={provider.id}
          testId={`local-provider-${provider.id}`}
          scope="device"
          tile={<ProviderTile providerId={provider.id} name={provider.name} />}
          name={provider.name}
          status={<LocalProviderStatus state={props.localProviderStates?.get(provider.id)} credentialHealth={providerHealth(provider.id)} />}
          meta={<ProviderMeta id={provider.id} parts={[deviceSourceLabel(provider.source), needsCredentialRecovery(provider.id) && provider.source === "env" ? "Update the environment credential, then restart the workspace." : null]} />}
          actions={needsCredentialRecovery(provider.id) && provider.source === "env"
            ? <span className="text-xs text-muted-foreground" title="Update the environment credential, then restart the workspace.">Update environment</span>
            : needsCredentialRecovery(provider.id)
            ? <Button variant="outline" disabled={rowsBusy || !ready || locked || !props.onReplaceProviderKey} onClick={() => void props.onReplaceProviderKey?.(provider.id)}>Replace key</Button>
            : <Button variant="ghost" disabled={rowsBusy || !ready || !props.canDisconnectProvider(provider)} onClick={() => void props.onDisconnectProvider(provider.id)}>{props.disconnectingProviderId === provider.id ? t("settings.disconnecting") : props.canDisconnectProvider(provider) ? t("settings.disconnect") : t("settings.managed_by_env")}</Button>}
        />)}
        {disabled.map((provider) => <ProviderRow
          key={`disabled:${provider.id}`}
          testId="disabled-provider"
          scope="device"
          tile={<ProviderTile providerId={provider.id} name={provider.name} />}
          name={provider.name}
          status={<ProviderStatus tone="neutral">{t("settings.provider_disabled_badge")}</ProviderStatus>}
          meta={<ProviderMeta id={provider.id} parts={[t("settings.provider_disabled_hint")]} />}
          actions={<Button variant="ghost" disabled={rowsBusy || (props.enablingProviderId ?? null) !== null} onClick={() => void props.onEnableProvider?.(provider.id)}>{props.enablingProviderId === provider.id ? t("settings.enabling_provider") : t("settings.enable_provider")}</Button>}
        />)}
      </ProviderList> : ready ? <p className="text-sm text-muted-foreground">{t("settings.no_providers_connected")}</p> : null}



      {props.providerConnectError ? <SettingsNotice tone="error">{props.providerConnectError}</SettingsNotice> : null}
      {props.providerDisconnectStatus ? <SettingsNotice>{props.providerDisconnectStatus}</SettingsNotice> : null}
      {props.providerDisconnectError ? <SettingsNotice tone="error">{props.providerDisconnectError}</SettingsNotice> : null}
    </section>


  </LayoutStack>;
}
