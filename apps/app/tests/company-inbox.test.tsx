/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { InboxResults } from "../src/react-app/domains/aiopc/inbox-page";

test("routine results expose project, output and failure details", () => {
  const html = renderToStaticMarkup(<InboxResults items={[
    { id: "one", name: "Morning report", projectRoot: "/company/projects/alpha", status: "succeeded", result: "Three leads", error: null, finishedAt: 1780000000000 },
    { id: "two", name: "Evening report", projectRoot: "/company/projects/beta", status: "failed", result: null, error: "Service unavailable", finishedAt: null },
  ]} />);
  for (const text of ["Morning report", "Evening report", "alpha", "beta", "Three leads", "Service unavailable", "Failed"]) {
    expect(html).toContain(text);
  }
});
