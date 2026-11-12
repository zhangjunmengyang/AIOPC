import { expect, test } from "bun:test";
import { projectTaskHref, projectWorkHref, readProjectTaskId, readProjectWorkSection, sessionProjectTaskHref } from "../src/react-app/domains/aiopc/project-work-navigation";

test("project work pages retain the company and project route through navigation", () => {
  const project = "/workspace/company/projects/%E5%93%81%E7%89%8C";
  for (const section of ["overview", "tasks", "routines"] as const) {
    const href = projectWorkHref(project, section);
    const url = new URL(href, "http://localhost");
    expect(url.pathname).toBe(project);
    expect(readProjectWorkSection(url.search)).toBe(section);
  }
  expect(readProjectWorkSection("?view=unexpected")).toBe("overview");
});

test("a conversation returns to its task only through a valid project binding", () => {
  expect(sessionProjectTaskHref("company", { projectId: "proj:品牌", taskId: "task_123" }))
    .toBe("/workspace/company/projects/%E5%93%81%E7%89%8C?view=tasks&task=task_123");
  expect(sessionProjectTaskHref("company", { projectId: null, taskId: "task_123" })).toBeUndefined();
  expect(sessionProjectTaskHref("company", { projectId: "proj:../outside", taskId: "task_123" })).toBeUndefined();
  expect(sessionProjectTaskHref("company", { projectId: "proj:Alpha", taskId: "../outside" })).toBeUndefined();
  expect(sessionProjectTaskHref("company", { projectId: "proj:Alpha" })).toBeUndefined();
});

test("a task deep link keeps its project path and only selects a task in the board view", () => {
  const project = "/workspace/company/projects/%E5%93%81%E7%89%8C";
  const href = new URL(projectTaskHref(project, "task_123"), "http://localhost");
  expect(href.pathname).toBe(project);
  expect(readProjectWorkSection(href.search)).toBe("tasks");
  expect(readProjectTaskId(href.search)).toBe("task_123");
  expect(readProjectTaskId("?view=routines&task=task_123")).toBeUndefined();
  expect(readProjectTaskId("?view=tasks&task=%2Foutside")).toBeUndefined();
  expect(projectTaskHref(project)).toBe(`${project}?view=tasks`);
});
