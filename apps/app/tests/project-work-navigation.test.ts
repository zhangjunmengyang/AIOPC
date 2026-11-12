import { expect, test } from "bun:test";
import { projectTaskHref, projectWorkHref, readProjectTaskId, readProjectWorkSection } from "../src/react-app/domains/aiopc/project-work-navigation";

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
