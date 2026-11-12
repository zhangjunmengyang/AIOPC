import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { currentLocale, setLocale, type Language } from "../src/i18n";
import type { TaskBoardPageProps } from "../src/react-app/domains/aiopc/tasks/task-board-page";
import type { ProjectTask } from "../src/react-app/domains/aiopc/tasks/task-client";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { TaskBoardPage } = await import("../src/react-app/domains/aiopc/tasks/task-board-page");
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

const projectPath = "/company/projects/launch";
const task: ProjectTask = {
  id: "launch-draft", title: "Draft launch post", description: "Write the first draft.",
  status: "blocked", requestedStatus: "in_progress", assignee: "writer", parent: null, blockedBy: ["research"],
  deliverables: [{ kind: "publish", path: "content/launch.md", label: "Launch draft" }],
  createdAt: "2026-11-12T10:00:00Z", updatedAt: "2026-11-12T10:00:00Z",
  activity: [{ id: "activity-1", at: "2026-11-12T10:00:00Z", actor: "agent", action: "created", fields: [] }],
};
const dependency: ProjectTask = {
  ...task, id: "research", title: "Read interviews", status: "todo", requestedStatus: undefined,
  assignee: null, deliverables: [], blockedBy: [], activity: [],
};

let previousLocale: Language;
beforeEach(() => {
  previousLocale = currentLocale();
  setLocale("en");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => setLocale(previousLocale));

function button(label: string, scope: ParentNode = document) {
  const target = Array.from(scope.querySelectorAll("button")).find(
    (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()) === label,
  );
  if (!target) throw new Error(`No button named ${label}`);
  return target;
}

async function renderBoard({ preview = false, item = task, seedTasks = true, props }: {
  preview?: boolean; item?: ProjectTask; seedTasks?: boolean; props?: Partial<TaskBoardPageProps>;
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  client.setQueryData(["aiopc", "connection"], { status: "ready", url: "http://localhost:3847", token: "board-test", error: "", home: "/company" });
  if (seedTasks) client.setQueryData(["aiopc", projectPath, "tasks"], { items: [item, dependency] });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const open = spyOn({ session(_id: string) {} }, "session");
  const linked: string[] = [];
  const unlinked: string[] = [];
  const deliverables: string[] = [];
  const render = (overrides = props) => act(async () => root.render(<QueryClientProvider client={client}>
    <TaskBoardPage projectPath={projectPath} projectName="Launch" roles={[{ name: "writer", label: "Content writer" }]}
      sessions={[{ id: "ses_draft", title: "Draft conversation", taskId: "launch-draft" },
        { id: "ses_other", title: "Other task's conversation", taskId: "research" },
        { id: "ses_free", title: "Unlinked conversation" }]}
      onOpenSession={open} onOpenDeliverable={preview ? undefined : (item) => { deliverables.push(item.path); }}
      onBindSession={async (taskId, sessionId) => { linked.push(`${taskId}/${sessionId}`); }}
      onUnbindSession={async (taskId, sessionId) => { unlinked.push(`${taskId}/${sessionId}`); }} {...overrides} />
  </QueryClientProvider>));
  await render();
  return { client, host, open, linked, unlinked, deliverables, render, close: async () => {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  } };
}

test("shows task status, role and deliverable on the board and opens the linked conversation from detail", async () => {
  const board = await renderBoard();
  try {
    const blocked = board.host.querySelector('[data-task-status="blocked"]')!;
    expect(blocked.textContent).toContain("Content writer");
    await act(async () => button("Launch draft", blocked).click());
    expect(board.deliverables).toEqual(["content/launch.md"]);
    await act(async () => button("Draft launch post", blocked).click());
    const detail = document.querySelector('[role="dialog"]')!;
    expect(detail.textContent).toContain("Read interviews");
    expect(detail.textContent).toContain("Agent created the task");
    await act(async () => button("Draft conversation", detail).click());
    expect(board.open).toHaveBeenCalledWith("ses_draft");
  } finally {
    await board.close();
  }
});

test("previews a publish draft through the existing scoped file endpoint", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => new Response("# Launch preview"));
  const board = await renderBoard({ preview: true });
  try {
    await act(async () => button("Launch draft").click());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/file");
    expect(url.searchParams.get("workspace")).toBe(projectPath);
    expect(url.searchParams.get("path")).toBe(`${projectPath}/content/launch.md`);
    expect(url.searchParams.get("token")).toBe("board-test");
  } finally {
    await board.close();
    fetchMock.mockRestore();
  }
});

test("does not open out-of-project paths or unsupported deliverable kinds", async () => {
  const item = { ...task, deliverables: [
    { kind: "file", path: "../private.md", label: "Invalid path" },
    { kind: "url", path: "content/launch.md", label: "Invalid kind" },
  ] } as ProjectTask;
  const board = await renderBoard({ item });
  try {
    await act(async () => button("Invalid path").click());
    expect(board.host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't open this deliverable.");
    await act(async () => button("Invalid kind").click());
    expect(board.deliverables).toEqual([]);
  } finally {
    await board.close();
  }
});

test("links an available project conversation and keeps conversations assigned to other tasks out of the picker", async () => {
  const board = await renderBoard();
  try {
    await act(async () => button("Draft launch post").click());
    const detail = document.querySelector('[role="dialog"]')!;
    const picker = detail.querySelector<HTMLSelectElement>('select[name="conversation"]')!;
    expect(Array.from(picker.options).map((option) => option.value)).toEqual(["", "ses_free"]);
    await act(async () => {
      picker.value = "ses_free";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Link conversation", detail).click());
    expect(board.linked).toEqual(["launch-draft/ses_free"]);
    await act(async () => button("Unlink Draft conversation", detail).click());
    expect(board.unlinked).toEqual(["launch-draft/ses_draft"]);
  } finally {
    await board.close();
  }
});

test("saves only changed fields and keeps the requested status of a dependency-blocked task", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    expect(url.searchParams.get("workspace")).toBe(projectPath);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer board-test");
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const saved = { ...task, assignee: null };
    return Response.json(method === "PATCH" ? { item: saved } : { items: [saved, dependency] });
  });
  const board = await renderBoard();
  try {
    await act(async () => button("Draft launch post").click());
    await act(async () => button("Edit task").click());
    const form = document.querySelector("form")!;
    const assignee = form.elements.namedItem("assignee") as HTMLSelectElement;
    expect(document.getElementById(assignee.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Assignee");
    expect((form.elements.namedItem("status") as HTMLSelectElement).value).toBe("in_progress");
    await act(async () => {
      assignee.value = "";
      assignee.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Save changes").click());
    expect(calls).toContainEqual({ method: "PATCH", path: "/api/tasks/launch-draft", body: { assignee: null, expectedUpdatedAt: task.updatedAt } });
    expect(board.host.querySelector('[data-task-status="blocked"]')?.textContent).toContain("Unassigned");
  } finally {
    await board.close();
    fetchMock.mockRestore();
  }
});

test("a task route opens after loading and renders the goal control for that task", async () => {
  let respond: ((response: Response) => void) | undefined;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => { respond = resolve; }));
  const board = await renderBoard({
    seedTasks: false,
    props: { taskId: task.id, onTaskIdChange: () => undefined, renderTaskGoal: (item) => <p>Goal for {item.id}</p> },
  });
  try {
    expect(board.host.textContent).toContain("Loading tasks");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      respond?.(Response.json({ items: [task, dependency] }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(task.title);
    expect(dialog?.textContent).toContain(`Goal for ${task.id}`);
  } finally {
    await board.close();
    fetchMock.mockRestore();
  }
});

test("route-driven task details follow navigation, report a missing task, and request closing the route", async () => {
  const changes: Array<string | null> = [];
  const onTaskIdChange = (id: string | null) => { changes.push(id); };
  const dialog = () => document.querySelector('[role="dialog"]');
  const title = () => dialog()?.querySelector("h2")?.textContent;
  const board = await renderBoard({ props: { onTaskIdChange } });
  try {
    await act(async () => button(task.title, board.host).click());
    expect(changes).toEqual([task.id]);
    expect(dialog()).toBeNull();

    await board.render({ taskId: task.id, onTaskIdChange });
    expect(title()).toBe(task.title);
    await act(async () => button("Edit task", dialog()!).click());
    expect(title()).toBe("Edit task");
    await board.render({ taskId: dependency.id, onTaskIdChange });
    expect(title()).toBe(dependency.title);
    await board.render({ taskId: task.id, onTaskIdChange });
    expect(title()).toBe(task.title);
    await act(async () => button("Draft conversation", dialog()!).click());
    expect(board.open).toHaveBeenCalledWith("ses_draft");
    expect(changes).toEqual([task.id]);

    const otherProject = "/company/projects/other";
    await act(async () => board.client.setQueryData(["aiopc", otherProject, "tasks"], { items: [dependency] }));
    await board.render({ projectPath: otherProject, projectName: "Other", taskId: task.id, onTaskIdChange });
    expect(title()).toBe("This task is no longer available.");
    await act(async () => button("Close", dialog()!).click());
    expect(changes).toEqual([task.id, null]);
    await board.render({ projectPath: otherProject, projectName: "Other", onTaskIdChange });
    expect(dialog()).toBeNull();
  } finally {
    await board.close();
  }
});
