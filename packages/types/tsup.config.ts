import { defineConfig } from "tsup"

export default defineConfig({
  // Source-only exports get declarations from tsc. Emit JavaScript only for
  // exports whose production runtime target lives in dist.
  entry: {
    "browser-demonstration": "src/browser-demonstration.ts",
    "google-drive-upload": "src/google-drive-upload.ts",
    "opencode-config-error": "src/opencode-config-error.ts",
    "microsoft-drive-transfer": "src/microsoft-drive-transfer.ts",
    "managed-provider-config": "src/managed-provider-config.ts",
    "model-fast": "src/model-fast.ts",
    "agent-permissions-runtime": "src/agent-permissions-runtime.ts",
    "desktop-policies-runtime": "src/desktop-policies-runtime.ts",
    "auto-router": "src/auto-router.ts",
    "mcp-app-timing": "src/mcp-app-timing.ts",
    "connection-action-app": "src/connection-action-app.ts",
  },
  tsconfig: "./tsconfig.json",
  format: ["esm"],
  dts: false,
  clean: true,
  target: "es2022",
  platform: "neutral",
  sourcemap: false,
  splitting: false,
  treeshake: true,
  external: ["zod"],
})
