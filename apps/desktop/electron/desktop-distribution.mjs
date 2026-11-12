// AIOPC has one local desktop distribution.
export const PUBLIC_DESKTOP_DISTRIBUTION = Object.freeze({
  flavor: "public",
  appName: "AIOPC",
  appIdentifier: "com.aiopc.desktop",
  protocolScheme: "aiopc",
});

export function resolveDesktopDistribution() {
  return PUBLIC_DESKTOP_DISTRIBUTION;
}
