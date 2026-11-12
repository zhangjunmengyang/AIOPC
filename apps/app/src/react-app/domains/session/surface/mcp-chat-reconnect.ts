import type { UIMessage } from "ai"
import { z } from "zod"
import { connectionFromChatToolPart } from "@/components/tools/error-attribution"
import type { ConnectionActionPayload } from "@openwork/types/connection-action-app"

export type ChatConnectionDecisionRequest = {
  requestId: string
  owner: string
  sessionId: string
  turnId: string
  toolCallId: string
  connectionId: string
  questionToolCallId?: string
}

export type ChatConnectionDecisionResponse =
  | { outcome: "connected"; continuation: "review_remaining_work"; repeatCompletedWrites: false }
  | { outcome: "skipped"; continuation: "without_connection"; alternativeAuthorization: false }

export type ChatConnectionDecisionBinding = {
  request: ChatConnectionDecisionRequest
  isPending: () => boolean
  respond: (response: ChatConnectionDecisionResponse) => Promise<void>
}

export function isCurrentChatConnectionDecision(
  request: ChatConnectionDecisionRequest,
  owner: string | null,
  sessionId: string,
  messages: readonly UIMessage[],
): boolean {
  if (!owner || request.owner !== owner || request.sessionId !== sessionId || !request.requestId) return false
  const turnIndex = messages.findLastIndex(message => message.role === "user")
  if (turnIndex < 0 || messages[turnIndex].id !== request.turnId) return false
  return isLatestTurnToolCall(messages, request.toolCallId)
}

/** Whether a tool call ran in the conversation's latest turn, after the last user message. */
export function isLatestTurnToolCall(messages: readonly UIMessage[], toolCallId: string): boolean {
  const turnIndex = messages.findLastIndex(message => message.role === "user")
  return turnIndex >= 0 && messages.slice(turnIndex + 1).some(message => message.role === "assistant"
    && message.parts.some(part => part.type === "dynamic-tool" && part.toolCallId === toolCallId))
}

const reservedConnectionQuestionItemSchema = z.object({
  header: z.literal("Connection"),
  options: z.tuple([z.object({ label: z.literal("Authenticate") }), z.object({ label: z.literal("Skip") })]),
  multiple: z.literal(false),
  custom: z.literal(false).optional(),
})
const questionItemsSchema = z.object({ questions: z.array(z.unknown()) })

export function isReservedConnectionQuestion(question: unknown): boolean {
  const parsed = questionItemsSchema.safeParse(question)
  return parsed.success && parsed.data.questions.some(item => reservedConnectionQuestionItemSchema.safeParse(item).success)
}

/**
 * The question the standard composer panel answers. A reserved connection
 * question leaves the panel only while a native card is bound to it; an
 * unbound one falls back to the ordinary Authenticate/Skip panel so the turn
 * never dead-ends.
 */
export function composerQuestionForConnectionDecision<T>(
  question: T | null | undefined,
  decision: ChatConnectionDecisionRequest | null,
): T | null {
  if (!question) return null
  return decision && isReservedConnectionQuestion(question) ? null : question
}

const nativeConnectionQuestionSchema = z.object({
  questions: z.tuple([reservedConnectionQuestionItemSchema.extend({ question: z.string() })]),
  id: z.string().min(1),
  sessionID: z.string().optional(),
  tool: z.object({ callID: z.string().min(1), messageID: z.string().optional() }).optional(),
})

export function nativeChatConnectionDecision(input: {
  question: unknown
  owner: string | null
  sessionId: string
  messages: readonly UIMessage[]
}): ChatConnectionDecisionRequest | null {
  if (!input.owner) return null
  const parsed = nativeConnectionQuestionSchema.safeParse(input.question)
  if (!parsed.success) return null
  const question = parsed.data
  if (question.sessionID !== undefined && question.sessionID !== input.sessionId) return null
  const turnIndex = input.messages.findLastIndex(message => message.role === "user")
  if (turnIndex < 0) return null
  const currentMessages = input.messages.slice(turnIndex + 1).filter(message => message.role === "assistant")
  const questionTool = question.tool
  const questionParts = currentMessages.flatMap(message => message.parts.flatMap(part => {
    if (!questionTool || part.type !== "dynamic-tool" || part.toolName !== "question"
      || (part.state !== "input-available" && part.state !== "input-streaming")
      || (questionTool.messageID && questionTool.messageID !== message.id)) return []
    const sourcePartId = part.callProviderMetadata?.openwork?.sourcePartId
    const matches = part.toolCallId === questionTool.callID
      || (Boolean(questionTool.messageID) && typeof sourcePartId === "string" && sourcePartId === questionTool.callID)
    return matches ? [part.toolCallId] : []
  }))
  if (questionTool && questionParts.length !== 1) return null
  // The question pauses the turn, so a blocker reported by ordinary discovery
  // (no `intent: "connect"`) counts here. The latest report for a connection
  // wins and hosts the card; earlier reports stay quiet sentence lines.
  const connections = new Map<string, { connection: ConnectionActionPayload; toolCallId: string; oauth: boolean }>()
  for (const message of currentMessages) {
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool" || (part.state !== "output-available" && part.state !== "output-error")) continue
      const found = connectionFromChatToolPart(part, { allowDiscovery: true })
      if (!found) continue
      const { connection, action } = found
      connections.set(connection.connectionId, { connection, toolCallId: part.toolCallId, oauth: action?.connectionId === connection.connectionId })
    }
  }
  const blockers = [...connections.values()].filter(entry => entry.connection.state !== "connected")
  const questionText = question.questions[0].question
  const named = blockers.filter(entry => questionText === `Connect ${entry.connection.connectionName} to continue?`)
  if (named.length !== 1) return null
  const blocker = named[0]
  if (!blocker.oauth || blocker.connection.actor !== "member"
    || (blocker.connection.action?.type !== "connect" && blocker.connection.action?.type !== "reconnect")) return null
  return {
    requestId: question.id, owner: input.owner, sessionId: input.sessionId,
    turnId: input.messages[turnIndex].id, toolCallId: blocker.toolCallId, connectionId: blocker.connection.connectionId,
    ...(questionParts[0] ? { questionToolCallId: questionParts[0] } : {}),
  }
}

export const CHAT_CONNECTION_CONTINUE_PROMPT = "I have connected it. Continue the task.";
