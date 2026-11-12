import { expect, test } from "bun:test";

import {
  automationLocalDateTimeInput,
  automationLocalDateTimeTimestamp,
} from "@openwork/types/automation-schedule";

test("single-run form interprets the input in the schedule zone", () => {
  const time = automationLocalDateTimeTimestamp("2026-11-12T09:15", "Asia/Shanghai");
  expect(time).toBe(Date.parse("2026-11-12T01:15:00Z"));
  expect(automationLocalDateTimeInput(time!, "Asia/Shanghai")).toBe("2026-11-12T09:15");
  expect(automationLocalDateTimeInput(time!, "America/New_York")).toBe("2026-11-11T20:15");
});

test("single-run form rejects invalid dates and uses the clock scheduler's DST rules", () => {
  expect(automationLocalDateTimeTimestamp("2026-02-31T01:30", "UTC")).toBeNull();
  expect(automationLocalDateTimeTimestamp("2026-11-01T01:30", "Invalid/Zone")).toBeNull();
  expect(automationLocalDateTimeTimestamp("2026-11-01T01:30", "America/New_York"))
    .toBe(Date.parse("2026-11-01T05:30:00Z"));
  expect(automationLocalDateTimeTimestamp("2026-03-08T02:30", "America/New_York"))
    .toBe(Date.parse("2026-03-08T07:00:00Z"));
});
