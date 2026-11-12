import { describe, expect, test } from "bun:test";
import {
  buildTeamRoster,
  buildTeamOutputs,
  teamCardSkillNames,
  teamProjectsForCompany,
  latestTeamToolTitle,
  startOfTeamWeek,
} from "../src/react-app/domains/aiopc/team-data";

describe("AIOPC team activity", () => {
  const roles = [
    { id: "brand", name: "品牌设计师", description: "", reportsTo: null, skills: ["naming"] },
    { id: "product", name: "产品", description: "", reportsTo: null, skills: [] },
  ];
  const meta = {
    wait: { agentName: "brand", projectId: "proj:Alpha" },
    busy: { agentName: "brand", projectId: "proj:Beta" },
    old: { agentName: "brand" },
    removed: { agentName: "former" },
    archived: { agentName: "product", projectId: "proj:Alpha" },
  };
  const sessions = [
    { id: "old", title: "旧会话", time: { updated: 70 } },
    { id: "wait", title: "审阅品牌", time: { updated: 100 } },
    { id: "busy", title: "在做海报", time: { updated: 120 } },
    { id: "archived", title: "已归档", time: { updated: 150, archived: 160 } },
    { id: "unbound", title: "未分配角色", time: { updated: 200 } },
  ];

  test("uses trusted role bindings and prioritizes attention over work or past conversations", () => {
    const [brand, product] = buildTeamRoster(roles, meta, sessions, {
      active: new Set(["busy", "archived", "unbound"]),
      waiting: new Set(["wait"]),
    });
    expect(brand?.status).toBe("waiting");
    expect(brand?.currentSession?.id).toBe("wait");
    expect(brand?.sessions.map(({ id, projectId }) => [id, projectId])).toEqual([
      ["wait", "proj:Alpha"], ["busy", "proj:Beta"], ["old", null],
    ]);
    expect(product?.status).toBe("idle");
    expect(product?.sessions).toEqual([]);
  });

  test("does not label the latest idle chat as current work or treat unavailable status as idle", () => {
    const [brand] = buildTeamRoster(roles, meta, sessions, {
      active: null, waiting: new Set(),
    });
    expect(brand?.status).toBe("unknown");
    expect(brand?.currentSession).toBeNull();
    expect(brand?.sessions[0]?.id).toBe("busy");
  });

  test("includes recent native activity when the sidebar session page omits that session", () => {
    const [brand] = buildTeamRoster(roles, meta, [], {
      active: new Set(["busy"]), waiting: new Set(),
    });
    expect(brand?.currentSession).toMatchObject({ id: "busy", projectId: "proj:Beta" });
    expect(brand?.status).toBe("working");
  });

  test("card shows resident skills plus adoptions only from its active conversation project", () => {
    const projects = [
      { id: "proj:Alpha", skills: ["naming", "alpha-skill"] },
      { id: "proj:Beta", skills: ["beta-skill"] },
    ];
    const [working] = buildTeamRoster(roles, meta, sessions, { active: new Set(["wait"]), waiting: new Set() });
    const [idle] = buildTeamRoster(roles, meta, sessions, { active: new Set(), waiting: new Set() });
    expect(teamCardSkillNames(working!, projects)).toEqual(["naming", "alpha-skill"]);
    expect(teamCardSkillNames(idle!, projects)).toEqual(["naming"]);
  });

  test("only reads business projects confirmed by the company's role endpoint", () => {
    const listed = [
      { id: "proj:Alpha", name: "Alpha", path: "/company/projects/Alpha" },
      { id: "proj:Other", name: "Other", path: "/company/projects/Other" },
    ];
    expect(teamProjectsForCompany(listed, { "proj:Alpha": [] })).toEqual([
      { id: "proj:Alpha", name: "Alpha", directory: "/company/projects/Alpha", skills: [] },
    ]);
    expect(teamProjectsForCompany(listed, undefined)).toEqual([]);
  });

  test("reads the newest actual tool title from assistant messages, with a tool-name fallback", () => {
    const messages = [
      { info: { role: "assistant", time: { created: 10 } }, parts: [
        { type: "tool", tool: "read", state: { title: "读取品牌简介", time: { start: 11 } } },
      ] },
      { info: { role: "assistant", time: { created: 20 } }, parts: [
        { type: "tool", tool: "write", state: { title: "", time: { start: 21 } } },
        { type: "text" },
      ] },
      { info: { role: "user", time: { created: 25 } }, parts: [
        { type: "tool", tool: "wrong", state: { title: "错误归属" } },
      ] },
    ];
    expect(latestTeamToolTitle(messages)).toBe("write");
    expect(latestTeamToolTitle(messages.slice(0, 1))).toBe("读取品牌简介");
    expect(latestTeamToolTitle([])).toBeNull();
  });

  test("counts this week's task deliverable updates and attributes publish history only to its own project session", () => {
    const monday = new Date(2026, 10, 9).getTime();
    expect(startOfTeamWeek(new Date(2026, 10, 12, 15))).toBe(monday);
    const newDate = new Date(2026, 10, 11).toISOString();
    const oldDate = new Date(2026, 10, 8).toISOString();
    const task = {
      id: "same",
      title: "发布准备",
      assignee: "brand",
      status: "done",
      deliverables: [{ kind: "file" as const, path: "assets/cover.png" }],
      updatedAt: newDate,
      activity: [{ at: newDate, fields: ["title"] }, { at: oldDate, fields: ["deliverables"] }],
    };
    const { byRole, unattributed } = buildTeamOutputs([
      {
        id: "proj:Alpha", name: "Alpha", directory: "/company/projects/Alpha",
        tasks: [task, { ...task, id: "new", activity: [{ at: newDate, fields: ["deliverables"] }] }],
        history: [
          { at: Date.parse(newDate) / 1_000, platform: "x", status: "published", session_id: "wait", url: "https://example.org/post" },
          { at: Date.parse(newDate) / 1_000, platform: "x", status: "composer_filled", session_id: "busy" },
          { at: Date.parse(newDate) / 1_000, platform: "x", status: "failed", session_id: "wait" },
          { at: Date.parse(newDate) / 1_000, platform: "x", status: "composer_opened", session_id: "wait" },
          { at: Date.parse(oldDate) / 1_000, platform: "x", status: "published", session_id: "wait" },
        ],
      },
    ], meta, new Set(["brand", "product"]), monday);
    expect(byRole.get("brand")?.map((entry) => entry.kind)).toEqual(["task", "publish"]);
    expect(unattributed.map((entry) => entry.kind)).toEqual(["publish"]);
  });
});
