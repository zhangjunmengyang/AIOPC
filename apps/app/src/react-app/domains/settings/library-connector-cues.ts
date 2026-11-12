import { resolveExtensionIconUrl } from "../../design-system/extension-icon-src";
export type LibraryConnectorCue = {
  id: string;
  name: string;
  iconSrc?: string;
  iconSlug?: string;
  serviceUrl?: string;
  faviconDomain?: string;
};

export function libraryConnectorIconUrls(cue: LibraryConnectorCue): string[] {
  const primary = resolveExtensionIconUrl(cue);
  const fallbackService = cue.faviconDomain
    ? `https://${cue.faviconDomain}`
    : cue.serviceUrl;
  const serviceIcon = fallbackService
    ? resolveExtensionIconUrl({ serviceUrl: fallbackService })
    : undefined;
  return [...new Set([primary, serviceIcon].filter((url): url is string => Boolean(url)))];
}
