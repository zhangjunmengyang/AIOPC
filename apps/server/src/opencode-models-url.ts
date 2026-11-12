/** Use the engine's public model catalog or an explicit user override. */
export async function resolveOpencodeModelsUrl(options: { env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return (options.env ?? process.env).OPENCODE_MODELS_URL?.trim() || "https://models.dev";
}
