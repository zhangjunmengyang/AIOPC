/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { t } from "../src/i18n";
import type { Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";

const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
let createRoot: typeof import("react-dom/client")["createRoot"];
let AccountStatusMenu: typeof import("../src/react-app/domains/session/sidebar/account-status-menu")["AccountStatusMenu"];
let ShellConfigProvider: typeof import("../src/react-app/shell/shell-config")["ShellConfigProvider"];
let root: Root | null = null;
let host: HTMLDivElement;
let previousAct: unknown;
let settingsOpened = 0;

// Keep the router, menu primitives, status resolution, and shell config real.
// Only replace context hooks that require the desktop/cloud application shell.

mock.module("../src/react-app/kernel/platform", () => ({
  usePlatform: () => ({ openLink: () => {} }),
}));
mock.module("../src/react-app/shell/control/control-provider", () => ({
  useControlAction: () => {},
}));



beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  createRoot = (await import("react-dom/client")).createRoot;
  AccountStatusMenu = (await import("../src/react-app/domains/session/sidebar/account-status-menu")).AccountStatusMenu;
  ShellConfigProvider = (await import("../src/react-app/shell/shell-config")).ShellConfigProvider;
});
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });
beforeEach(() => {
  previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  settingsOpened = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host.remove();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
});

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

async function openMenu(developerMode: boolean) {
  await act(async () => root?.render(
    <MemoryRouter initialEntries={["/workspace/test/session/test"]}>
      <ShellConfigProvider>
        <AccountStatusMenu
          clientConnected
          openworkServerStatus="connected"
          developerMode={developerMode}
          showConnectionStatus
          providerConnectedIds={["openwork"]}
          mcpConnectedCount={0}
          onOpenAccountSettings={() => { settingsOpened += 1; }}
        />
        <LocationProbe />
      </ShellConfigProvider>
    </MemoryRouter>,
  ));
  const trigger = host.querySelector<HTMLButtonElement>('[data-testid="account-status-menu"]');
  expect(trigger).not.toBeNull();
  await act(async () => { trigger?.click(); });
  const menu = document.querySelector('[role="menu"]');
  expect(menu).not.toBeNull();
  expect(menu?.textContent).not.toContain("OpenWork Connect");
  return menu;
}

test.each([false, true])("local settings are reachable with developerMode=%s", async (developerMode) => {
  const menu = await openMenu(developerMode);
  const settings = [...menu!.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === t("status.settings"));
  expect(settings).toBeDefined();
  await act(async () => { settings?.click(); });
  expect(settingsOpened).toBe(1);
});
