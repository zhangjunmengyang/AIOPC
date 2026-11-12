import type { DynamicToolUIPart } from "ai";
import { getMcpServerName, MCP_QUICK_CONNECT } from "@/app/constants";
import type { McpServerEntry } from "@/app/types";
import { resolveExtensionIconUrl } from "@/react-app/design-system/extension-icon-src";

export type ConnectorToolIdentity = {
  id: string;
  name: string;
  iconUrl: string | null;
  serviceUrl: string | null;
  toolNamespace: string | null;
  connectionId: string | null;
  connectedForMe?: boolean;
};

const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Configured MCP servers replace catalog presentation with the user's own names and URLs. */
export function buildConnectorToolIdentities(input: { mcpServers: McpServerEntry[] }): ConnectorToolIdentity[] {
  const identities = new Map<string, ConnectorToolIdentity>();
  for (const entry of MCP_QUICK_CONNECT) {
    if (entry.kind !== "mcp") continue;
    const serverName = getMcpServerName(entry);
    identities.set(serverName, {
      id: `catalog:${serverName}`, name: entry.name,
      iconUrl: resolveExtensionIconUrl({ iconSrc: entry.iconSrc, iconSlug: entry.iconSlug, serviceUrl: entry.url }) ?? null,
      serviceUrl: entry.url ?? null, toolNamespace: serverName, connectionId: null,
    });
  }
  for (const server of input.mcpServers) {
    const url = server.config.url?.trim() || null;
    const name = server.name.trim();
    const catalog = MCP_QUICK_CONNECT.find(entry => (url && entry.url === url)
      || normalized(getMcpServerName(entry)) === normalized(name) || normalized(entry.name) === normalized(name));
    identities.set(name, {
      id: `mcp:${server.id ?? name}`, name: server.name,
      iconUrl: resolveExtensionIconUrl({ iconSrc: catalog?.iconSrc, iconSlug: catalog?.iconSlug, serviceUrl: url ?? catalog?.url }) ?? null,
      serviceUrl: url, toolNamespace: name || null, connectionId: null,
    });
  }
  return [...identities.values()];
}

/** Prefer the longest namespace so servers whose names share a prefix stay distinct. */
export function resolveConnectorToolIdentity(part: DynamicToolUIPart, identities: ConnectorToolIdentity[]): ConnectorToolIdentity | null {
  return identities.filter(identity => identity.toolNamespace)
    .sort((left, right) => (right.toolNamespace?.length ?? 0) - (left.toolNamespace?.length ?? 0))
    .find(identity => part.toolName === identity.toolNamespace || part.toolName.startsWith(`${identity.toolNamespace}_`)) ?? null;
}
