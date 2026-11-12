import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { currentLocale, setLocale, type Language } from "../src/i18n";
import type { CompanyGoalSnapshot, CompanyGoalsClient } from "../src/react-app/domains/aiopc/goals/goal-client";
import { projectTaskHref } from "../src/react-app/domains/aiopc/project-work-navigation";
import { companyPageRoute } from "../src/react-app/shell/company-page-routes";
import { workspaceProjectsRoute } from "../src/react-app/shell/workspace-routes";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { CompanyGoalsPage } = await import("../src/react-app/domains/aiopc/goals/goals-page");
const { TaskGoalField } = await import("../src/react-app/domains/aiopc/goals/task-goal-field");
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

let previousLocale: Language;
beforeEach(() => {
  previousLocale = currentLocale();
  setLocale("zh");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => setLocale(previousLocale));

function button(host: ParentNode, text: string): HTMLButtonElement {
  const match = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.trim() === text);
  if (!match) throw new Error(`Missing button ${text}`);
  return match;
}

async function mountGoals() {
  const project = { id: "proj:甲", name: "甲", directory: "/company/projects/甲" };
  const otherProject = { id: "proj:乙", name: "乙", directory: "/company/projects/乙" };
  let snapshot: CompanyGoalSnapshot = {
    projects: [project, otherProject],
    items: [
      { id: "company-goal", title: "公司增长", description: "积累首批用户", status: "active", projectId: null, parentId: null },
      { id: "project-goal", title: "发布首版", description: "覆盖离线场景", status: "planned", projectId: project.id, parentId: "company-goal" },
      { id: "foreign-goal", title: "乙项目目标", description: "", status: "planned", projectId: otherProject.id, parentId: "company-goal" },
    ],
    links: [],
  };
  const client: CompanyGoalsClient = {
    listCompanyGoals: async () => snapshot,
    createCompanyGoal: async () => snapshot,
    updateCompanyGoal: async () => snapshot,
    setCompanyGoalTaskLink: async (_workspace, projectId, taskId, goalId) => {
      const other = snapshot.links.filter((item) => item.projectId !== projectId || item.taskId !== taskId);
      snapshot = { ...snapshot, links: goalId ? [...other, { projectId, taskId, goalId }] : other };
      return snapshot;
    },
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, gcTime: Infinity } } });
  queryClient.setQueryData(["company-goals", "", "company"], snapshot);
  queryClient.setQueryData(["aiopc", "connection"], { status: "ready", url: "http://localhost:3847", token: "goal-test", error: "", home: "/company" });
  queryClient.setQueryData(["aiopc", project.directory, "tasks"], { items: [{ id: "task-1", title: "整理首版材料", description: "核对截图和文案", status: "in_progress" }] });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const render = (goalId?: string) => act(async () => root.render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <div id="goal-page-test">
          <CompanyGoalsPage client={client} workspaceId="company" goalId={goalId}
            taskHref={(project, taskId) => projectTaskHref(workspaceProjectsRoute("company", project.name), taskId)} />
        </div>
        <div id="task-field-test">
          <TaskGoalField client={client} workspaceId="company" projectId={project.id} taskId="task-1"
            goalHref={(goalId) => companyPageRoute("company", "goals", goalId)} />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
  await render("project-goal");
  return { host, render, close: async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    host.remove();
  } };
}

test("shows the company-to-project goal hierarchy and opens goal details", async () => {
  const view = await mountGoals();
  try {
    const page = view.host.querySelector("#goal-page-test")!;
    expect(page.textContent).toContain("公司增长");
    expect(page.textContent).toContain("覆盖离线场景");
    await view.render("company-goal");
    expect(page.textContent).toContain("积累首批用户");
    expect(page.textContent).toContain("项目目标");
  } finally {
    await view.close();
  }
});

test("task field and goal details share saves, show task titles, and open the linked task", async () => {
  const view = await mountGoals();
  try {
    const page = view.host.querySelector("#goal-page-test")!;
    const task = view.host.querySelector("#task-field-test")!;
    const goal = task.querySelector<HTMLSelectElement>("select")!;
    expect(Array.from(goal.options).map((item) => item.value)).toEqual(["", "project-goal"]);
    await act(async () => {
      goal.value = "project-goal";
      goal.dispatchEvent(new Event("change", { bubbles: true }));
      button(task, "保存关联").click();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(page.querySelector("article a")?.getAttribute("href")).toBe("/workspace/company/projects/%E7%94%B2?view=tasks&task=task-1");
    expect(task.querySelector("a")?.getAttribute("href")).toBe("/workspace/company/goals/project-goal");
    await act(async () => button(page, "解除关联").click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(task.querySelector<HTMLSelectElement>("select")?.value).toBe("");
    expect(page.textContent).toContain("暂无关联任务");
  } finally {
    await view.close();
  }
});

test("can collapse and reopen a company branch while viewing one of its project goals", async () => {
  const view = await mountGoals();
  try {
    const disclosure = view.host.querySelector<HTMLButtonElement>('nav button[aria-expanded="true"]')!;
    const children = document.getElementById(disclosure.getAttribute("aria-controls")!)!;
    await act(async () => disclosure.click());
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(children.hidden).toBe(true);
    await act(async () => disclosure.click());
    expect(children.hidden).toBe(false);
  } finally {
    await view.close();
  }
});
