import { describe, expect, test } from "bun:test";
import { addLibraryConfigItem, validateLibraryItem } from "../src/react-app/domains/settings/local-library";
import { parseSkillMarkdown, skillMarkdown } from "../src/react-app/domains/settings/library";
import { parse } from "jsonc-parser";
const input = { name: "research", description: "Research: customers", instructions: "Ask about the last purchase." };
describe("local library creation", () => {
  test("adds a command without losing comments or other settings", () => {
    const result = addLibraryConfigItem('{\n // Keep this\n "model": "maas/example",\n}', "command", input);
    expect(result).toContain("// Keep this");
    expect(parse(result)).toEqual({ model: "maas/example", command: { research: { description: input.description, template: input.instructions } } });
  });
  test("refuses replacement and invalid configuration", () => {
    for (const raw of ['{"command":{"research":{}}}', '{"command":[]}', '{broken', 'null']) {
      expect(() => addLibraryConfigItem(raw, "command", input)).toThrow();
    }
  });
  test("rejects path traversal and empty instructions before writing", () => {
    expect(() => validateLibraryItem({...input, name: "../research"})).toThrow();
    expect(() => validateLibraryItem({...input, instructions: " "})).toThrow();
  });
  test("creates an agent with a prompt", () => {
    expect(parse(addLibraryConfigItem("{}", "agent", input)).agent.research).toEqual({ description: input.description, prompt: input.instructions, mode: "primary" });
  });
  test("skill frontmatter preserves punctuation and multiline descriptions", () => {
    const description = 'Research: customers\nquoted "words"';
    expect(parseSkillMarkdown(skillMarkdown(input.name, description, input.instructions))).toEqual({name: input.name, description, body: input.instructions});
  });
});
