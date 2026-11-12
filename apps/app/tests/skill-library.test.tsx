/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";

import { currentLocale, setLocale } from "../src/i18n";

let ownsDom = false;
let SkillLibrary: typeof import("../src/react-app/domains/settings/pages/skill-library")["SkillLibrary"];
let createRoot: typeof import("react-dom/client")["createRoot"];
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let restoreGlobals: (() => void) | undefined;

beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
  if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
  createRoot = (await import("react-dom/client")).createRoot;
  SkillLibrary = (await import("../src/react-app/domains/settings/pages/skill-library")).SkillLibrary;
});

afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  restoreGlobals?.();
});

const commit = "a".repeat(40);
const skill = {
  id: "clone-page",
  title: "clone-page",
  source_url: "https://github.com/example/skills/blob/" + commit + "/clone-page/SKILL.md",
  commit,
  names: { zh: ["复刻营销页"], en: ["Clone a landing page"] },
  descriptions: { zh: ["根据参考页重建营销页"] },
  categories: ["marketing"],
  license: "MIT",
  has_scripts: true,
  execution: "sandbox-only",
  specification: "passed",
  scan: "failed",
  snippet: "Search preview",
};

async function flushQueries() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}

test("catalog search uses the selected company and marks blocked and scripted candidates", async () => {
  const originalFetch = globalThis.fetch;
  const originalElectron = Reflect.get(window, "__OPENWORK_ELECTRON__");
  const originalAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const originalLocale = currentLocale();
  restoreGlobals = () => {
    globalThis.fetch = originalFetch;
    Reflect.set(window, "__OPENWORK_ELECTRON__", originalElectron);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalAct);
    setLocale(originalLocale);
  };
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Reflect.set(window, "__OPENWORK_ELECTRON__", { aiopc: { connection: async () => ({
    status: "ready", url: "http://localhost:8991", token: "test-token", error: "", home: "",
  }) } });
  setLocale("zh");
  const requests: URL[] = [];
  globalThis.fetch = (async (resource, init) => {
    const url = new URL(String(resource));
    requests.push(url);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
    return Response.json({ indexed: true, candidates: [skill, {
      ...skill, id: "scripted", title: "scripted", names: { zh: ["脚本技能"] }, scan: "passed",
    }] });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<QueryClientProvider client={client}>
    <SkillLibrary companyRoot="/tmp/test-company" canAdopt onAdopted={() => undefined} />
  </QueryClientProvider>));
  await flushQueries();
  expect(requests).toHaveLength(0);

  const input = host.querySelector<HTMLInputElement>('input[aria-label="搜索技能库"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "复刻营销页");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await flushQueries();
  expect(requests).toHaveLength(1);
  expect(requests[0]?.pathname).toBe("/api/skillhub/search");
  expect(requests[0]?.searchParams.get("q")).toBe("复刻营销页");
  expect(requests[0]?.searchParams.get("workspace")).toBe("/tmp/test-company");

  const rows = [...host.querySelectorAll("[data-library-integrated-row]")];
  expect(rows.map(row => row.querySelector("[data-library-status]")?.textContent)).toEqual(["不可采纳", "含脚本"]);
  expect(host.textContent).toContain("根据参考页重建营销页");
  expect(rows[0]?.querySelector('button[aria-label="查看 复刻营销页"]')).toBeTruthy();
});
