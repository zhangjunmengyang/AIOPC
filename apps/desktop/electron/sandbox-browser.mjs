/**
 * The browsing the AI does, run in the project's own environment.
 *
 * AIOPC's agent browses with the same tools as before (open, observe, act,
 * extract); what changed is where they run. Instead of a browser inside this
 * app — which Google and Cloudflare refuse — they drive the real Chromium in
 * the project's environment over its DevTools address, local container or paid
 * cloud browser alike. The project's logins are already there, so the AI sees
 * the same web the person does.
 */

import path from "node:path";
import { mkdir } from "node:fs/promises";

import { createCloudBrowser, publicAddressOnly } from "@openwork/computer-use/chromium";

const unavailable = (error) => ({ ok: false, code: "browser_unavailable", error });

export function createSandboxBrowser({ app, aiopcService, workspaceStore }) {
  // One browser per project environment, kept while its address stays the same.
  const browsers = new Map();

  async function selectedWorkspace() {
    const state = await workspaceStore.readWorkspaceState();
    const selectedId = state.selectedId || state.activeId || state.workspaces[0]?.id || "";
    const workspace = selectedId ? state.workspaces.find((entry) => entry?.id === selectedId) : state.workspaces[0];
    return String(workspace?.path ?? "").trim();
  }

  async function serviceRequest(method, route, workspaceRoot, body) {
    const connection = await aiopcService.connection();
    if (connection?.status !== "ready" || !connection.url) throw new Error("AIOPC 的服务还没有就绪");
    const url = new URL(route, connection.url);
    url.searchParams.set("workspace", workspaceRoot);
    // loopback-fetch: the AIOPC service this app started on 127.0.0.1
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${connection.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(180_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(String(data?.error ?? `AIOPC 服务返回 ${response.status}`));
    return data ?? {};
  }

  async function endpointFor(workspaceRoot) {
    const current = await serviceRequest("GET", "/api/environment", workspaceRoot);
    if (current?.running && current.cdp_url) return current.cdp_url;
    // Not up yet: starting it is part of browsing, so the AI never has to ask the person to.
    const started = await serviceRequest("POST", "/api/environment", workspaceRoot, { action: "start" });
    if (!started?.cdp_url) throw new Error("项目环境没有启动");
    return started.cdp_url;
  }

  async function browserFor(workspaceRoot) {
    const endpoint = await endpointFor(workspaceRoot);
    const existing = browsers.get(workspaceRoot);
    if (existing && existing.endpoint === endpoint) return existing.browser;
    existing?.browser.close();
    const directory = path.join(app.getPath("userData"), "sandbox-browser");
    await mkdir(directory, { recursive: true });
    const browser = createCloudBrowser({
      endpoint,
      statePath: path.join(directory, `${Buffer.from(workspaceRoot).toString("base64url").slice(-48)}.json`),
      enabled: () => true,
      assertActive: () => {},
      beforeInput: async () => {},
      // The environment is a machine of its own: its network, and its name lookups, are not this Mac's.
      // Judging an address by name here would be wrong, so only plainly private targets are refused.
      verifyEgress: async () => {},
      allowDestination: async (url) => publicAddressOnly(url),
    });
    browsers.set(workspaceRoot, { endpoint, browser, handedOver: false });
    return browser;
  }

  return {
    /** Serves the agent's browser tools (/browser/task) against the project's environment. */
    async browserTask(body, options = {}) {
      let workspaceRoot = "";
      try {
        workspaceRoot = await selectedWorkspace();
      } catch (error) {
        return unavailable(String(error?.message ?? error));
      }
      if (!workspaceRoot) return unavailable("还没有打开项目");
      let browser;
      try {
        browser = await browserFor(workspaceRoot);
      } catch (error) {
        return unavailable(`${String(error?.message ?? error)}。可以在「账号」页的项目环境里启动它。`);
      }
      const entry = browsers.get(workspaceRoot);
      const operation = String(body?.operation ?? "");
      if (entry?.handedOver && operation !== "handoff") {
        // Handing over ends the AI's turn, so anything arriving after it belongs to a later turn:
        // the person has had their go in the environment's picture and spoken again.
        browser.resume();
        entry.handedOver = false;
      }
      try {
        const result = await browser.request(body, { signal: options.signal, recovery: body?.browserRecovery === true });
        if (operation === "handoff" && result?.ok && entry) entry.handedOver = true;
        return result;
      } catch (error) {
        // A dropped connection means the environment restarted; the next call builds a fresh browser.
        browsers.delete(workspaceRoot);
        return { ok: false, code: error?.code ?? "browser_failed", error: String(error?.message ?? error) };
      }
    },
    close() {
      for (const { browser } of browsers.values()) browser.close();
      browsers.clear();
    },
  };
}
