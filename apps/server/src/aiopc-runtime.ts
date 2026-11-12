import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * AIOPC's own tools, skills and working instructions, added for every
 * workspace on both engines. The desktop app sets AIOPC_SERVICE_DIR (the
 * services/opc project) and AIOPC_UV (the uv binary that runs it); without
 * them nothing is added.
 */
function serviceDirectory(environment: NodeJS.ProcessEnv): string | null {
  const serviceDir = environment.AIOPC_SERVICE_DIR?.trim();
  return serviceDir && environment.AIOPC_UV?.trim() ? serviceDir : null;
}

/** The OPC MCP server. It runs over stdio, so the engine starts one per workspace with that folder as its working directory. */
export function aiopcMcpServers(environment: NodeJS.ProcessEnv = process.env): Record<string, Record<string, unknown>> {
  const serviceDir = serviceDirectory(environment);
  if (!serviceDir) return schedulerMcpServers(environment);
  const passthrough = ["AIOPC_HOME", "AIOPC_LIBRARY", "UV_PROJECT_ENVIRONMENT"] as const;
  const serviceEnvironment = Object.fromEntries(passthrough.flatMap((key) => {
    const value = environment[key]?.trim();
    return value ? [[key, value]] : [];
  }));
  return {
    ...schedulerMcpServers(environment),
    aiopc: {
      type: "local",
      command: [environment.AIOPC_UV!.trim(), "run", "--project", serviceDir, "--frozen", "--no-dev", "--quiet",
        "python", "-m", "aiopc.server", "--stdio"],
      environment: serviceEnvironment,
      enabled: true,
      // The first start may still be installing the service's Python packages.
      timeout: 120_000,
    },
  };
}

/** The scheduler uses a host-owned launcher and works with both engine versions. */
function schedulerMcpServers(environment: NodeJS.ProcessEnv): Record<string, Record<string, unknown>> {
  const node = environment.AIOPC_SCHEDULER_NODE?.trim();
  const entry = environment.AIOPC_SCHEDULER_ENTRY?.trim();
  const launcher = environment.OPENCODE_SCHEDULER_OPENCODE_PATH?.trim();
  const sdk = environment.AIOPC_SCHEDULER_SDK?.trim();
  if (!node || !entry || !launcher || !sdk) return {};
  const keys = ["AIOPC_SCHEDULER_NODE", "AIOPC_SCHEDULER_ENTRY", "OPENCODE_SCHEDULER_OPENCODE_PATH", "AIOPC_SCHEDULER_SDK", "AIOPC_HOME"] as const;
  return { scheduler: {
    type: "local", command: [node, entry], enabled: true,
    environment: { ELECTRON_RUN_AS_NODE: "1", ...Object.fromEntries(keys.flatMap(key => {
      const value = environment[key]?.trim();
      return value ? [[key, value]] : [];
    })) },
  } };
}

export function aiopcSkillDirectories(environment: NodeJS.ProcessEnv = process.env): string[] {
  const serviceDir = serviceDirectory(environment);
  return serviceDir ? [join(serviceDir, "skills")] : [];
}

/** Publishing reaches the outside world: the person confirms every call. */
export const AIOPC_ASK_TOOLS = ["aiopc_social_publish"] as const;

/** The base prompt followed by AIOPC's working instructions (services/opc/instructions.md). */
export function withAiopcInstructions(prompt: string, environment: NodeJS.ProcessEnv = process.env): string {
  const serviceDir = serviceDirectory(environment);
  if (!serviceDir) return prompt;
  try {
    const text = readFileSync(join(serviceDir, "instructions.md"), "utf8").trim();
    return text ? `${prompt}\n\n${text}` : prompt;
  } catch {
    return prompt;
  }
}
