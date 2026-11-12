import { ApiError } from "../errors.js";
import type { EnvService } from "../env-file.js";
import type { ServerConfig } from "../types.js";
import { callOpenAiImageGenerationExtensionAction, OPENAI_IMAGE_GENERATION_EXTENSION_ACTIONS, OPENAI_IMAGE_GENERATION_EXTENSION_ID } from "./openai-image-generation.js";

export function listExperimentalExtensionActions(extensionId: string) {
  return OPENAI_IMAGE_GENERATION_EXTENSION_ACTIONS.filter(action => !extensionId.trim() || action.extensionId === extensionId.trim());
}

export async function callExperimentalExtensionAction(config: ServerConfig, env: EnvService, input: unknown, _signal?: AbortSignal) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError(400, "invalid_payload", "Expected extension action call payload");
  const body = input as Record<string, unknown>;
  if (body.extensionId !== OPENAI_IMAGE_GENERATION_EXTENSION_ID || typeof body.action !== "string") throw new ApiError(404, "extension_action_not_found", "Extension action not found");
  const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args as Record<string, unknown> : {};
  const context = body.context && typeof body.context === "object" && !Array.isArray(body.context) ? body.context as Record<string, unknown> : {};
  const result = await callOpenAiImageGenerationExtensionAction(config, env, body.action, args, context);
  if (!result) throw new ApiError(404, "extension_action_not_found", "Extension action not found");
  return result;
}
