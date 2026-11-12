import { expect, test } from "bun:test";
import { scopeNewTaskComposer } from "../src/react-app/domains/session/chat/new-task-project-context";

test("a split project draft gets its own client, cwd and discovery functions while retaining user composer choices", () => {
  const base = { selectedAgent: "writer", selectedModel: { providerID: "local", modelID: "model" }, workspaceId: "company", executionDirectory: "/company/projects/A", listAgents: async () => ["A"] };
  const runtime = { workspaceId: "company", runtimeWorkspaceId: "company", workspaceRoot: "/company/projects/B", client: { id: "B" }, surface: { listAgents: async () => ["B"], listCommands: async () => [], searchFiles: async () => ["B.md"] } };
  const scoped = scopeNewTaskComposer(base as never, runtime as never);
  expect(scoped.workspaceId).toBe("company");
  expect(scoped.executionDirectory).toBe("/company/projects/B");
  expect(scoped.client).toBe(runtime.client as never);
  expect(scoped.listAgents).toBe(runtime.surface.listAgents as never);
  expect(scoped.selectedAgent).toBe("writer");
  expect(scoped.selectedModel).toEqual(base.selectedModel);
  expect(base.executionDirectory).toBe("/company/projects/A");
});
