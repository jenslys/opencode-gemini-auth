import { describe, expect, it } from "bun:test";

import { exchangeGeminiWithVerifier } from "./oauth";

describe("exchangeGeminiWithVerifier", () => {
  it("returns a failure when code is not a string", async () => {
    const result = await exchangeGeminiWithVerifier(
      { code: "not-a-string" } as unknown as string,
      "verifier",
    );

    expect(result.type).toBe("failed");
    if (result.type === "failed") {
      expect(result.error).toContain("Missing authorization code");
    }
  });

  it("returns a failure when verifier is not a string", async () => {
    const result = await exchangeGeminiWithVerifier(
      "auth-code",
      { verifier: "not-a-string" } as unknown as string,
    );

    expect(result.type).toBe("failed");
    if (result.type === "failed") {
      expect(result.error).toContain("Missing PKCE verifier");
    }
  });
});
