/**
 * Whether a page that lives in OpenWork Cloud (Artifacts, Automations) has a
 * sidebar entry and a route. AIOPC has no cloud deployment, so never.
 */
export function cloudSurfaceAvailable(_input: {
  /** Den's deployment flag for this page, false until the config has loaded. */
  deploymentEnabled: boolean;
  /** The first sign-in check has not finished. */
  authChecking: boolean;
  signedIn: boolean;
}): boolean {
  return false;
}
