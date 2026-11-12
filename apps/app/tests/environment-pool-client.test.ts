import { afterEach, expect, test } from "bun:test";
import {
  aiopcRequest,
  AiopcError,
  type AiopcConnection,
} from "../src/react-app/domains/aiopc/aiopc-client";
import { environmentTab } from "../src/react-app/domains/session/panel/use-side-panel-tabs";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const connection = {
  status: "ready",
  url: "http://localhost:8999",
  token: "fixture",
  home: "/home",
  error: "",
} as AiopcConnection;

test("binding confirmation preserves status and affected accounts without automatically retrying", async () => {
  const calls: Request[] = [];
  const response = {
    error: "Confirmation required",
    requires_confirmation: true,
    affectedAccounts: [{ account_id: "a", name: "Product account" }],
    confirmation: "confirm-once",
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return Response.json(response, { status: 409 });
  }) as typeof fetch;
  try {
    await aiopcRequest(
      connection,
      "/company",
      "POST",
      "/api/environments/env-1",
      { body: { action: "bind", project: "/company/projects/B" } },
    );
    throw new Error("expected confirmation");
  } catch (error) {
    expect(error).toBeInstanceOf(AiopcError);
    expect((error as AiopcError).status).toBe(409);
    expect((error as AiopcError).data).toEqual(response);
  }
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).searchParams.get("workspace")).toBe("/company");
});

test("two environments in one project have separate panel identities", () => {
  const a = environmentTab("env-A", "/company/projects/Product", "Account A");
  const b = environmentTab("env-B", "/company/projects/Product", "Account B");
  expect(a).toEqual({
    id: "environment:env-A",
    type: "environment",
    environmentId: "env-A",
    workspaceRoot: "/company/projects/Product",
    label: "Account A",
  });
  expect(b.id).not.toBe(a.id);
});
