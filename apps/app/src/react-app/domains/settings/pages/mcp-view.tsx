/** @jsxImportSource react */
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { TextInput } from "../../../design-system/text-input";
import { ExtensionCard } from "../../../design-system/extension-card";
import { ExtensionDetailModal } from "../../../design-system/extension-detail-modal";
import { getMcpServerName, type McpDirectoryInfo } from "../../../../app/constants";
import type { McpServerEntry, McpStatusMap } from "../../../../app/types";
import { revealDesktopItemInDir, type OpencodeConfigFile } from "../../../../app/lib/desktop";
import { AddMcpModal } from "../../connections/modals/add-mcp-modal";
import type { McpConnectResult } from "../../connections/store";
import { extensionFilterLabel, extensionInventoryFilters, primaryLibraryFilter, taxonomyForDirectoryEntry, type ExtensionInventoryFilter, type ExtensionInventoryState, type ExtensionTaxonomy } from "../extension-taxonomy";
import { libraryAgentDetailId, libraryCommandDetailId, libraryCommandTriggers, type LibraryAgentItem, type LibraryCommandItem, type LibraryAuthorableKind, type CreateLibraryItemInput } from "../library";
import { AddLibraryItemPage } from "./add-library-item-page";
import { LibraryAddControl } from "./library-add-control";

export type ReactMcpStatus = "connected" | "needs_auth" | "reconnect_required" | "needs_client_registration" | "failed" | "disabled" | "disconnected";
export type SkillItem = { name: string; description?: string; trigger?: string; path: string; content?: string };
export type McpViewProps = {
  busy: boolean; selectedWorkspaceRoot: string; installedSkills?: SkillItem[];
  installedCommands?: LibraryCommandItem[]; installedAgents?: LibraryAgentItem[];
  uninstallSkill?: (name: string) => void; readSkill?: (name: string) => Promise<{content: string} | null>;
  readConfigFile?: (scope: "project" | "global") => Promise<OpencodeConfigFile | null>;
  mcpServers: McpServerEntry[]; mcpStatus: string | null; mcpLastUpdatedAt: number | null;
  mcpStatuses: McpStatusMap; mcpConnectingName: string | null; managedOAuthAvailable?: boolean;
  allowManageExtensions: boolean; quickConnect: McpDirectoryInfo[];
  connectMcp: (entry: McpDirectoryInfo) => Promise<McpConnectResult>;
  authorizeMcp: (entry: McpServerEntry) => void;
  logoutMcpAuth: (name: string) => Promise<void> | void;
  removeMcp: (name: string) => void;
  setMcpEnabled?: (name: string, enabled: boolean) => Promise<void> | void;
  configSlotForEntry?: (entry: McpDirectoryInfo) => ReactNode;
  isExtensionConnected?: (entry: McpDirectoryInfo) => boolean;
  enablementContext?: import("../../../../app/enablement").EnablementContext;
  initialFilter?: ExtensionInventoryFilter; onFilterChange?: (filter: ExtensionInventoryFilter) => void;
  initialState?: ExtensionInventoryState;
  onStateChange?: (state: ExtensionInventoryState, filter: ExtensionInventoryFilter) => void;
  detailId?: string | null;
  onDetailIdChange?: (id: string | null, filter?: ExtensionInventoryFilter) => void;
  createLibraryItem?: (kind: LibraryAuthorableKind, input: CreateLibraryItemInput) => Promise<string>;
  onLibraryListsRefresh?: () => Promise<void> | void; onRefresh?: () => void;
  headerActionsTarget?: HTMLDivElement | null; pluginsContent?: ReactNode;
};
type Item = { id: string; name: string; description: string; taxonomy: ExtensionTaxonomy;
  entry?: McpDirectoryInfo; server?: McpServerEntry; skill?: SkillItem; command?: LibraryCommandItem; agent?: LibraryAgentItem };
export function McpView(props: McpViewProps) {
  const [filter, setFilter] = useState(primaryLibraryFilter(props.initialFilter));
  const [query, setQuery] = useState("");
  const [localDetail, setLocalDetail] = useState<string | null>(null);
  const [addMcp, setAddMcp] = useState(false);
  const [adding, setAdding] = useState<LibraryAuthorableKind | null>(null);
  const [skillContent, setSkillContent] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  useEffect(() => setFilter(primaryLibraryFilter(props.initialFilter)), [props.initialFilter]);
  const openDetail = (id: string | null) => { setLocalDetail(id); props.onDetailIdChange?.(id, filter); };
  const entries: Item[] = props.quickConnect.map(entry => ({
    id: entry.id ?? `mcp:${getMcpServerName(entry)}`, name: entry.name, description: entry.description,
    taxonomy: taxonomyForDirectoryEntry(entry), entry, server: props.mcpServers.find(server => server.name === getMcpServerName(entry)),
  }));
  const known = new Set(entries.flatMap(item => item.server ? [item.server.name] : []));
  const items: Item[] = [...entries,
    ...props.mcpServers.filter(server => !known.has(server.name)).map(server => ({ id: `mcp:${server.name}`, name: server.name, description: server.config.url ?? server.config.command?.join(" ") ?? "", taxonomy: "mcp" as const, server })),
    ...(props.installedSkills ?? []).map(skill => ({ id: `skill:${skill.name}`, name: skill.name, description: skill.description ?? "", taxonomy: "skill" as const, skill })),
    ...(props.installedCommands ?? []).map(command => ({ id: libraryCommandDetailId(command), name: command.name, description: command.description ?? "", taxonomy: "command" as const, command })),
    ...(props.installedAgents ?? []).map(agent => ({ id: libraryAgentDetailId(agent), name: agent.name, description: agent.description ?? "", taxonomy: "agent" as const, agent })),
  ];
  const detail = items.find(item => item.id === (props.detailId ?? localDetail));
  const skillName = detail?.skill?.name;
  useEffect(() => {
    setSkillContent(undefined);
    if (!skillName || !props.readSkill) return;
    let active = true;
    props.readSkill(skillName).then(result => { if (active) setSkillContent(result?.content); }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [skillName, props.readSkill]);
  const run = async (action: () => unknown | Promise<unknown>) => {
    setActing(true); setError(null);
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setActing(false); }
  };
  const connected = (item: Item) => item.server ? props.mcpStatuses[item.server.name]?.status === "connected" : item.entry ? props.isExtensionConnected?.(item.entry) ?? false : true;
  const controls = <div className="flex items-center gap-2">
    <Button variant="ghost" size="sm" onClick={props.onRefresh} disabled={props.busy}>刷新</Button>
    <LibraryAddControl kinds={filter === "connection" ? ["workspace-mcp"] : filter === "skill" ? ["skill", "command", "agent"] : filter === "plugin" ? [] : ["skill", "command", "agent", "workspace-mcp"]} onSelect={kind => {
      if (kind === "workspace-mcp") setAddMcp(true);
      else if (kind === "skill" || kind === "command" || kind === "agent") setAdding(kind);
    }} />
  </div>;
  if (adding && props.createLibraryItem) return <AddLibraryItemPage kind={adding} onClose={() => setAdding(null)} onCreate={async input => {
    const id = await props.createLibraryItem!(adding, input);
    await props.onLibraryListsRefresh?.(); props.onRefresh?.(); setAdding(null); openDetail(id);
  }} />;
  const server = detail?.server;
  const status = server ? props.mcpStatuses[server.name] : undefined;
  const connect = detail && (server ? () => props.authorizeMcp(server) : detail.entry ? () => run(() => props.connectMcp(detail.entry!)) : undefined);
  const config = <div className="grid gap-3">{detail?.entry && props.configSlotForEntry?.(detail.entry)}
    {server && <div className="flex gap-2">
      {props.setMcpEnabled && <Button variant="outline" size="sm" disabled={acting} onClick={() => run(() => props.setMcpEnabled!(server.name, server.config.enabled === false))}>{server.config.enabled === false ? "启用" : "停用"}</Button>}
      {server.config.oauth !== false && <Button variant="ghost" size="sm" disabled={acting} onClick={() => run(() => props.logoutMcpAuth(server.name))}>退出授权</Button>}
    </div>}
  </div>;
  const detailView = detail && <ExtensionDetailModal open onClose={() => openDetail(null)} name={detail.name} description={detail.description}
    taxonomy={detail.taxonomy} iconSlug={detail.entry?.iconSlug} iconSrc={detail.entry?.iconSrc} connected={connected(detail)}
    connecting={acting || (Boolean(server) && props.mcpConnectingName === server?.name)} presentation={props.onDetailIdChange ? "page" : "dialog"}
    errorInfo={error ?? (status && "error" in status ? status.error : null)}
    url={server?.config.url ?? detail.entry?.url} launchCommand={server?.config.command ?? detail.entry?.command}
    environment={server?.config.environment} configSlot={config} onConnect={connect || undefined} onReconnect={server ? connect || undefined : undefined}
    path={detail.skill?.path} onReveal={detail.skill ? () => { void revealDesktopItemInDir(detail.skill!.path); } : undefined}
    contentPreview={skillContent ?? detail.skill?.content ?? detail.command?.template ?? detail.agent?.prompt}
    triggers={detail.command ? libraryCommandTriggers(detail.command) : detail.agent ? [`@${detail.agent.name}`] : detail.skill?.trigger ? [detail.skill.trigger] : undefined}
    sourceLabel="当前项目" onUninstall={server ? () => props.removeMcp(server.name) : detail.skill && props.uninstallSkill ? () => props.uninstallSkill!(detail.skill!.name) : undefined}
  />;
  if (detail && props.onDetailIdChange) return detailView;
  const visible = items.filter(item => (filter === "all" || primaryLibraryFilter(item.taxonomy) === filter) && `${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="grid gap-5">
    {props.headerActionsTarget ? createPortal(controls, props.headerActionsTarget) : <div className="flex justify-end">{controls}</div>}
    <div className="flex flex-wrap items-center gap-2">{extensionInventoryFilters.map(value => <Button key={value} variant={filter === value ? "secondary" : "ghost"} size="sm" onClick={() => {setFilter(value); props.onFilterChange?.(value);}}>{extensionFilterLabel(value)}</Button>)}</div>
    <TextInput aria-label="搜索扩展" placeholder="搜索扩展" value={query} onChange={event => setQuery(event.target.value)} />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {props.mcpStatus && <p role="status" className="text-sm text-muted-foreground">{props.mcpStatus}</p>}
    <div className="grid gap-2">{visible.map(item => <ExtensionCard key={item.id} name={item.name} description={item.description} taxonomy={item.taxonomy} iconSlug={item.entry?.iconSlug} iconSrc={item.entry?.iconSrc} connected={connected(item)} onClick={() => openDetail(item.id)} />)}</div>
    {!visible.length && filter !== "plugin" && <p className="py-8 text-center text-sm text-muted-foreground">这里还没有扩展，可从右上角添加。</p>}
    {(filter === "plugin" || filter === "all") && props.pluginsContent}
    {detailView}<AddMcpModal open={addMcp} onClose={() => setAddMcp(false)} onAdd={props.connectMcp} busy={props.busy} />
  </section>;
}
