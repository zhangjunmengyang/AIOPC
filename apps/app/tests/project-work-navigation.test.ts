import { expect, test } from "bun:test";
import { projectWorkHref, readProjectWorkSection } from "../src/react-app/domains/aiopc/project-work-navigation";

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
