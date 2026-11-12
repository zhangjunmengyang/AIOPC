import { expect, test } from "bun:test";
import { FAST_DEFAULT_VARIANT } from "@openwork/types/model-fast";
import { modelTriggerSettings } from "../src/react-app/domains/models/model-catalog";
import type { ModelOption } from "../src/app/types";

// What the composer's model trigger reads at launch, before the saved sign-in and the engine have answered.

const behaviorOptions = [
  { value: null, label: "Default", description: "" },
  { value: "high", label: "High", description: "" },
  { value: FAST_DEFAULT_VARIANT, label: "Default + Fast", description: "" },
  { value: "__openwork_fast_v1/variant/high", label: "High + Fast", description: "" },
];
const gateway: ModelOption = {
  providerID: "openai", modelID: "gpt-6-luna", title: "GPT-6 Luna", description: "OpenAI",
  behaviorTitle: "Reasoning effort", behaviorLabel: "Default", behaviorDescription: "", behaviorValue: null,
  behaviorOptions, isFree: false,
};
const local: ModelOption = { ...gateway, providerID: "anthropic", modelID: "claude-fixture", title: "Claude Fixture" };
const current = { providerID: gateway.providerID, modelID: gateway.modelID };

test("the trigger never shows a raw setting id before the list is verified", () => {
  const input = { model: current, options: [], value: FAST_DEFAULT_VARIANT };
  // Nothing follows "Select model".
  expect(modelTriggerSettings({ ...input, named: false, verified: false })).toEqual({ summary: null, fast: false });
  expect(modelTriggerSettings({ ...input, named: false, verified: true })).toEqual({ summary: null, fast: false });
  // A named model whose settings have not loaded yet says nothing about a setting it cannot describe.
  expect(modelTriggerSettings({ ...input, named: true, verified: false })).toEqual({ summary: null, fast: false });
});

test("a setting the verified list does not offer is still called out", () => {
  const { summary } = modelTriggerSettings({ model: current, named: true, verified: true, options: [{ value: "high", label: "High" }], value: "retired" });
  expect(summary).toContain("not in current catalog");
});

test("listed settings read the same whether or not the list is verified", () => {
  for (const verified of [true, false]) {
    const settings = (value: string | null) => modelTriggerSettings({ model: current, named: true, verified, options: behaviorOptions, value });
    expect(settings(null)).toEqual({ summary: null, fast: false });
    expect(settings("high")).toEqual({ summary: "High", fast: false });
    expect(settings("__openwork_fast_v1/variant/high")).toEqual({ summary: "High", fast: true });
  }
});
