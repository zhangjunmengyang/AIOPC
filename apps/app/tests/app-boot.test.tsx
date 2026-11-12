import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as globalQueueDrainer from "../src/react-app/domains/session/sync/global-queue-drainer";
import { DesktopUpdaterProvider } from "../src/react-app/domains/settings/state/desktop-updater-provider";
import { useLocal } from "../src/react-app/kernel/local-provider";
import { ServerProvider } from "../src/react-app/kernel/server-provider";
import { BootStateProvider, useBootState } from "../src/react-app/shell/boot-state";
import { LocalAppProviders } from "../src/react-app/shell/providers";
import { useReloadCoordinator } from "../src/react-app/shell/reload-coordinator";

const mounts: string[] = [];
function Probe() {
  useLocal(); useReloadCoordinator(); const boot = useBootState();
  useEffect(() => { mounts.push("mount"); }, []);
  return <DesktopUpdaterProvider><div>local-contexts-ok boot={boot.phase}</div></DesktopUpdaterProvider>;
}
function Tree({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <BootStateProvider><ServerProvider defaultUrl="http://127.0.0.1:4096">
      <LocalAppProviders>{children}</LocalAppProviders>
    </ServerProvider></BootStateProvider>
  </QueryClientProvider>;
}
describe("local app boot", () => {
  beforeEach(() => { GlobalRegistrator.register({ url: "http://localhost:5173/" }); Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true); mounts.length = 0; });
  afterEach(async () => { await GlobalRegistrator.unregister(); });
  test("starts local runtime and supplies chat and updater contexts without a cloud account", async () => {
    const commands: string[] = [];
    Reflect.set(window, "__OPENWORK_ELECTRON__", { meta: { distribution: { flavor: "public", appName: "AIOPC", appIdentifier: "com.aiopc.desktop", protocolScheme: "aiopc", requireSignin: false, requireActivation: false } }, invokeDesktop: async (name: string) => { commands.push(name); } });
    const drainer = spyOn(globalQueueDrainer, "startGlobalQueueDrainer").mockImplementation(() => () => {});
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
    try {
      await act(async () => { root.render(<Tree><Probe /></Tree>); });
      expect(container.textContent).toContain("local-contexts-ok");
      expect(commands).toContain("workspaceBootstrap");
      expect(commands.some(command => /Den|ConnectLink|automationRunner|DesktopBootstrapConfig/.test(command))).toBe(false);
      expect(drainer).toHaveBeenCalledTimes(1); expect(mounts).toEqual(["mount"]);
    } finally { await act(async () => root.unmount()); container.remove(); drainer.mockRestore(); }
  });
});
