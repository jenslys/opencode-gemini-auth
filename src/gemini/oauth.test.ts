import { beforeEach, describe, expect, it, mock } from "bun:test";

import { exchangeGeminiWithVerifier } from "./oauth";

describe("exchangeGeminiWithVerifier", () => {
  beforeEach(() => {
    mock.restore();
  });

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

  it("allows retry after a failed token exchange", async () => {
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ error: "internal_error" }),
        { status: 500, statusText: "Internal Server Error" },
      );
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const first = await exchangeGeminiWithVerifier("retry-code-1", "retry-verifier-1");
    const second = await exchangeGeminiWithVerifier("retry-code-1", "retry-verifier-1");

    expect(first.type).toBe("failed");
    expect(second.type).toBe("failed");
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("marks code consumed after successful exchange", async () => {
    let callCount = 0;
    const fetchMock = mock(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            access_token: "access-token",
            expires_in: 3600,
            refresh_token: "refresh-token",
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ email: "user@example.com" }), { status: 200 });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const first = await exchangeGeminiWithVerifier("success-code-1", "success-verifier-1");
    const second = await exchangeGeminiWithVerifier("success-code-1", "success-verifier-1");

    expect(first.type).toBe("success");
    expect(second.type).toBe("failed");
    if (second.type === "failed") {
      expect(second.error).toContain("already submitted");
    }
    expect(callCount).toBe(2);
  });
});
