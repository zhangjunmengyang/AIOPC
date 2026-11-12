import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { McpCatalog } from "@/mcp/catalog"
import { CodeModeTool } from "@/tool/code-mode"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { Tool } from "@/tool/tool"
import * as Truncate from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { Effect, Layer } from "effect"

const def = { name: "probe", inputSchema: { type: "object" as const, properties: {} } }

test("AIOPC standard MCP transport keeps concurrent native session identities outside arguments", async () => {
  const server = new Server({ name: "probe", version: "1" }, { capabilities: { tools: {} } })
  const seen: unknown[] = []
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    seen.push(params._meta?.["ai.opencode/sessionID"])
    return { content: [] }
  })
  const client = new Client({ name: "probe", version: "1" })
  const [left, right] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(left), server.connect(right)])
  try {
    await Promise.all(["ses_one", "ses_two"].map(async sessionID => {
      const tool = McpCatalog.convertTool(def, client, 1000, sessionID)
      await tool.execute?.({ sessionID: "forged", _meta: { "ai.opencode/sessionID": "forged" } }, { toolCallId: sessionID, messages: [] })
    }))
    expect(seen.sort()).toEqual(["ses_one", "ses_two"])
  } finally { await Promise.all([client.close(), server.close()]) }
})

test("AIOPC code mode child MCP call uses native context, ignoring forged tool arguments", async () => {
  let seen: unknown
  const entry = { def, client: { callTool: async (params: any) => { seen = params._meta?.["ai.opencode/sessionID"]; return { content: [] } } } } as unknown as MCP.McpTool
  const layer = Layer.mergeAll(
    Layer.mock(Plugin.Service, { trigger: ((_name, _input, output) => Effect.succeed(output)) as Plugin.Interface["trigger"] }),
    Layer.mock(Truncate.Service, { output: (text: string) => Effect.succeed({ content: text, truncated: false as const }) }),
    Layer.mock(Agent.Service, { get: () => Effect.succeed({ name: "build", permission: [] } as any) }),
    Layer.mock(Session.Service, { get: () => Effect.succeed({ permission: [] } as any) }),
    Layer.mock(MCP.Service, { tools: () => Effect.succeed({ aiopc_probe: entry }), clients: () => Effect.succeed({ aiopc: {} as any }) }),
  )
  const context: Tool.Context = { sessionID: SessionID.make("ses_native"), messageID: MessageID.make("msg_native"),
    agent: "build", abort: new AbortController().signal, callID: "call_native", messages: [], metadata: () => Effect.void, ask: () => Effect.void }
  const tool = await Effect.runPromise(CodeModeTool.pipe(Effect.flatMap(Tool.init), Effect.provide(layer)))
  await Effect.runPromise(tool.execute({ code: 'return await tools.aiopc.probe({ sessionID: "forged" })' }, context))
  expect(seen).toBe("ses_native")
})
