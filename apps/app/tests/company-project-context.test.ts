import { expect, test } from "bun:test";
import { executionDirectoryForGroup, isProjectSessionGroup, projectNameFromGroupId, projectGroupForDirectory, projectGroupForSession, sessionExecutionDirectory } from "../src/react-app/domains/aiopc/company-project";

test("stable project groups resolve a project directory while company and custom groups retain the company home", () => {
  expect(projectNameFromGroupId("proj:咖啡馆" )).toBe("咖啡馆");
  expect(executionDirectoryForGroup("/company", "proj:咖啡馆")).toBe("/company/projects/咖啡馆");
  expect(executionDirectoryForGroup("/company/", "proj:Auday")).toBe("/company/projects/Auday");
  expect(executionDirectoryForGroup("/company", null)).toBe("/company");
  expect(executionDirectoryForGroup("/company", "grp_notes")).toBe("/company");
});

test("OPC pages carry only the current company's direct project context", () => {
  expect(projectGroupForDirectory("/company", "/company/projects/Alpha")).toBe("proj:Alpha");
  expect(projectGroupForDirectory("/company/", "/company/projects/咖啡馆")).toBe("proj:咖啡馆");
  expect(projectGroupForDirectory("/company", "/company")).toBeNull();
  expect(projectGroupForDirectory("/company", "/company-other/projects/Alpha")).toBeNull();
  expect(projectGroupForDirectory("/company", "/company/projects/Alpha/nested")).toBeNull();
});

test("canonical engine home keeps project context when the selected company path is an alias", () => {
  expect(projectGroupForSession("/tmp/company", { directory: "/private/tmp/company", executionDirectory: "/private/tmp/company/projects/Alpha" })).toBe("proj:Alpha");
  expect(projectGroupForSession("/tmp/company", { directory: "/private/tmp/company", executionDirectory: "/private/tmp/company" }, "proj:Alpha")).toBeNull();
  expect(projectGroupForSession("/tmp/company", undefined, "proj:Alpha")).toBe("proj:Alpha");
});

test("session execution directory comes from the engine while drafts derive it from their captured project", () => {
  expect(sessionExecutionDirectory("/company", { executionDirectory: "/company/projects/A", directory: "/company" }, "proj:B")).toBe("/company/projects/A");
  expect(sessionExecutionDirectory("/company", { directory: "/company" }, "proj:B")).toBe("/company");
  expect(sessionExecutionDirectory("/company", undefined, "proj:B")).toBe("/company/projects/B");
});

test("project group parsing cannot turn an untrusted group id into a path outside the project folder", () => {
  for (const id of ["proj:", "proj:..", "proj:.", "proj:../outside", "proj:a/b", "proj:a\\b", "grp_proj:a"]) {
    expect(isProjectSessionGroup(id)).toBe(false);
    expect(executionDirectoryForGroup("/company", id)).toBe("/company");
  }
  expect(isProjectSessionGroup("proj:Product A")).toBe(true);
});
