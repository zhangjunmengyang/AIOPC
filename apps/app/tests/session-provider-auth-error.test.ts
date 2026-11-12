import { describe, expect, test } from "bun:test"
import { presentOpencodeSessionError } from "../src/react-app/domains/session/sync/session-error"

  test("leaves personal-provider API key copy unchanged", () => {
    const presentation = presentOpencodeSessionError({
      name: "APIError",
      data: { statusCode: 401, message: "Invalid API key", responseBody: JSON.stringify({ error: { message: "Invalid API key", code: "invalid_api_key" } }) },
    })
    expect(presentation.kind).toBe("provider-credentials")
    expect(presentation.title).toBe("Your API key wasn’t accepted")
    expect(presentation.description).toBe("Check or replace your API key in model settings.")
  })
