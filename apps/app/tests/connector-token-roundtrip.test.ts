import { expect, test } from "bun:test";
import { connectorPrompt } from "../src/react-app/domains/session/surface/composer/connector-token";
import { splitComposerPillText } from "../src/react-app/domains/session/surface/composer/composer-pills";
import { sentTokensFromInstructions } from "../src/react-app/domains/session/surface/composer/sent-message-tokens";

test("a configured MCP connector remains a chip after its instruction is decoded", () => {
  const instruction = connectorPrompt("GitHub");
  expect(instruction).toContain("configured MCP tools");
  expect(splitComposerPillText(`[connector GitHub]${instruction} list my pull requests`)).toEqual([{ kind: "connector", name: "GitHub" }, " list my pull requests"]);
  expect(sentTokensFromInstructions(instruction)).toEqual([{ kind: "pill", pill: { kind: "connector", name: "GitHub" } }]);
});
