export type ComposerPluginFile = {
  configObjectId: string;
  externalMcpConnectionId?: string | null;
  versionId: string | null;
  objectType: string;
  title: string;
  path: string;
  updatedAt: string | null;
  skillName?: string;
  marketplaceName?: string;
  pluginName?: string;
};

export type ComposerPlugin = {
  pluginId: string;
  marketplaceId: string | null;
  name: string;
  description: string | null;
  updatedAt: string | null;
  files: ComposerPluginFile[];
  importedAt: number | null;
};

