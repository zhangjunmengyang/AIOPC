import { expect, test } from "bun:test";
import { t } from "../src/i18n";

test("every occurrence of a placeholder is filled in", () => {
  // "{name}" appears twice in this string.
  const text = t("extensions.connector_note_codes", { name: "Acme", lng: "en" });
  expect(text).toBe("Acme asks for two codes from your Acme app first. Then you sign in with your own account.");
  expect(text).not.toContain("{name}");
});

test("placeholder values are inserted literally", () => {
  expect(t("extensions.connector_sign_in_with", { name: "$& Co", lng: "en" })).toBe("Sign in with $& Co");
});
