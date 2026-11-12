import { expect, test } from "bun:test";
import { matchPath } from "react-router";

import {
  COMPANY_PAGES,
  companyPagePattern,
  companyPageRoute,
} from "../src/react-app/shell/company-page-routes";

test("opens each company page under the selected workspace", () => {
  for (const page of COMPANY_PAGES) {
    const url = companyPageRoute("company + 1", page);
    expect(url).toBe(`/workspace/company%20%2B%201/${page}`);
    expect(matchPath(companyPagePattern(page), url)?.params.workspaceId).toBe("company%20%2B%201");
  }
});

test("goal detail has a reloadable company URL and other pages ignore a goal ID", () => {
  const url = companyPageRoute("company-1", "goals", "goal 1");
  expect(url).toBe("/workspace/company-1/goals/goal%201");
  expect(matchPath(companyPagePattern("goals"), url)?.params.goalId).toBe("goal%201");
  expect(companyPageRoute("company-2", "costs", "goal 1")).toBe("/workspace/company-2/costs");
});
