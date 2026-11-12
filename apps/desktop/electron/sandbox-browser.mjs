/** Conversation-owned browser access to a leased project environment. */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createCloudBrowser, publicAddressOnly } from "@openwork/computer-use/chromium";

const failure = (error, code = "browser_unavailable") => ({ ok: false, code: error?.code ?? code, error: String(error?.message ?? error) });

export function createSandboxBrowser({ app, aiopcService, resolveSessionContext, fetchImpl = fetch,
  createBrowser = createCloudBrowser, heartbeatMs = 5_000, pollMs = 250 }) {
  const browsers = new Map();
  const tasks = new Set();
  let closed = false;

  async function serviceRequest(method, route, workspace, environment, body, signal) {
    const connection = await aiopcService.connection();
    if (connection?.status !== "ready" || !connection.url) throw new Error("AIOPC 的服务还没有就绪");
    const url = new URL(route, connection.url);
    url.searchParams.set("workspace", workspace);
    if (environment) url.searchParams.set("environment", environment);
    const response = await fetchImpl(url, {
      method, headers: { Authorization: `Bearer ${connection.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(body?.action === "start" ? 180_000 : 15_000)]) : AbortSignal.timeout(body?.action === "start" ? 180_000 : 15_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(String(data?.error ?? `AIOPC 服务返回 ${response.status}`)), { code: data?.code });
    return data ?? {};
  }

  async function browserFor(environment, active) {
    const key = `${environment.id}:${environment.bindingRevision}`;
    for (const [oldKey, entry] of browsers) {
      if (entry.environmentId === environment.id && (oldKey !== key || entry.endpoint !== environment.cdp_url)) {
        entry.active?.controller.abort(Object.assign(new Error("环境绑定已变化"), { code: "binding_changed" }));
        entry.browser.close(); browsers.delete(oldKey);
      }
    }
    let entry = browsers.get(key);
    if (!entry) {
      const directory = path.join(app.getPath("userData"), "sandbox-browser");
      await mkdir(directory, { recursive: true });
      entry = { key, environmentId: environment.id, endpoint: environment.cdp_url, active, browser: null };
      const assertActive = () => {
        if (closed || !entry.active) throw new Error("浏览器操作已结束");
        entry.active.controller.signal.throwIfAborted();
      };
      entry.browser = createBrowser({ endpoint: environment.cdp_url,
        statePath: path.join(directory, `${createHash("sha256").update(key).digest("hex")}.json`),
        enabled: () => !closed, assertActive,
        beforeInput: async () => { assertActive(); await entry.active.validate(); assertActive(); },
        verifyEgress: async () => {}, allowDestination: async url => publicAddressOnly(url),
      });
      browsers.set(key, entry);
    }
    entry.active = active;
    return entry;
  }

  return {
    async browserTask(body, options = {}) {
      if (!body?.sessionId || typeof body.sessionId !== "string") return failure("浏览工具需要可信会话", "missing_session");
      if (closed) return failure("浏览器连接已关闭");
      const controller = new AbortController(); tasks.add(controller);
      const cancel = () => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) cancel(); else options.signal?.addEventListener("abort", cancel, { once: true });
      let lease, requestId = randomUUID(), operationId = randomUUID(), entry, heartbeat, renewing, operationStarted = false;
      try {
        const context = await resolveSessionContext(body.sessionId);
        if (context.sessionId !== body.sessionId || !context.runtimeId || !context.projectId || !context.projectDirectory) {
          return failure("请在项目会话中使用项目环境", "project_required");
        }
        const selected = typeof body.environment === "string" ? body.environment : body.args?.environment;
        let environment = await serviceRequest("GET", "/api/environment", context.projectDirectory, selected, undefined, controller.signal);
        if (!environment.id || !Number.isInteger(environment.bindingRevision)) throw new Error("项目环境没有有效绑定");
        const payload = { runtimeId: context.runtimeId, sessionId: context.sessionId, bindingRevision: environment.bindingRevision };
        lease = (action, extra = {}, signal = controller.signal) => serviceRequest("POST", "/api/environment/lease", context.projectDirectory, environment.id,
          { ...payload, action, requestId, operationId, ...extra }, signal);
        let granted;
        do {
          granted = await lease("acquire");
          if (granted.state === "queued") { requestId = granted.requestId; await delay(pollMs, undefined, { signal: controller.signal }); }
          else if (granted.state !== "granted" || !granted.leaseId) throw new Error("环境租约响应无效");
        } while (granted.state !== "granted");
        const leaseId = granted.leaseId;
        const requestLease = lease;
        lease = (action, extra, signal) => requestLease(action, { leaseId, ...extra }, signal);
        while ((await lease("begin")).state !== "granted") await delay(pollMs, undefined, { signal: controller.signal });
        operationStarted = true;
        const validate = async () => {
          try { await lease("heartbeat"); }
          catch (error) { controller.abort(error); throw error; }
        };
        // A heartbeat failure aborts even a request waiting for a long page load.
        heartbeat = setInterval(() => {
          if (renewing) return;
          renewing = validate().catch(() => {}).finally(() => { renewing = undefined; });
        }, heartbeatMs);
        if (!environment.running || !environment.cdp_url) environment = await serviceRequest("POST", "/api/environment", context.projectDirectory, environment.id, { action: "start" }, controller.signal);
        if (!environment.cdp_url || environment.bindingRevision !== payload.bindingRevision) throw Object.assign(new Error("项目环境绑定已变化"), { code: "binding_changed" });
        entry = await browserFor(environment, { controller, validate });
        // Resume only after the broker grants automation ownership; a human lease blocks above.
        entry.browser.resume();
        const result = await entry.browser.request(body, { signal: controller.signal, recovery: body.browserRecovery === true });
        if (body.operation === "handoff" && result?.ok) {
          clearInterval(heartbeat); await renewing;
          controller.signal.throwIfAborted();
          await lease("wait");
        }
        return result;
      } catch (error) {
        controller.abort(error);
        if (entry) { entry.browser.close(); browsers.delete(entry.key); }
        return failure(controller.signal.reason ?? error, "browser_failed");
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        await renewing;
        if (entry) entry.active = null;
        if (lease) {
          if (operationStarted) await lease("end", {}, null).catch(() => {});
          else await lease("cancel", {}, null).catch(() => {});
        }
        tasks.delete(controller); options.signal?.removeEventListener("abort", cancel);
      }
    },
    close() {
      closed = true;
      for (const controller of tasks) controller.abort(new Error("浏览器连接已关闭"));
      for (const entry of browsers.values()) entry.browser.close();
      browsers.clear();
    },
  };
}
