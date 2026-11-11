type DesktopFeatureKey = "claudeAgentProvider" | "computerUse" | "computerSessionHistory" | "remoteComputers" | "settledSessions" | "composerBackgroundTasks" | "agentQuestions" | "standardCodeMode" | "parallelComputerUse" | "steadyLiveTurn" | "plainFreeModel"

/**
 * AIOPC's desktop features, fixed in the app. OpenWork read these from its
 * cloud; the values match OpenWork's public defaults, with cloud-only
 * features (remote computers, the hosted free model) off.
 */
const DESKTOP_FEATURES: Record<DesktopFeatureKey, boolean> = {
  claudeAgentProvider: false,
  computerUse: true,
  computerSessionHistory: true,
  remoteComputers: false,
  settledSessions: true,
  composerBackgroundTasks: true,
  agentQuestions: true,
  standardCodeMode: true,
  parallelComputerUse: true,
  steadyLiveTurn: true,
  plainFreeModel: false,
}

export function useDesktopFeature(key: DesktopFeatureKey): boolean {
  return DESKTOP_FEATURES[key]
}
