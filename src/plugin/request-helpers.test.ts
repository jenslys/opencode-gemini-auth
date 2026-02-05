import { describe, expect, it } from "bun:test";

import { enhanceGeminiErrorResponse } from "./request-helpers";

describe("enhanceGeminiErrorResponse", () => {
  it("adds retry hint and rate-limit message for 429 rate limits", () => {
    const body = {
      error: {
        message: "rate limited",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "RATE_LIMIT_EXCEEDED",
            domain: "cloudcode-pa.googleapis.com",
          },
          {
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "5s",
          },
        ],
      },
    };

    const result = enhanceGeminiErrorResponse(body, 429);
    expect(result?.retryAfterMs).toBe(5000);
    expect(result?.body?.error?.message).toContain("Rate limit exceeded");
  });

  it("adds quota exhausted message for terminal limits", () => {
    const body = {
      error: {
        message: "quota exhausted",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "QUOTA_EXHAUSTED",
            domain: "cloudcode-pa.googleapis.com",
          },
        ],
      },
    };

    const result = enhanceGeminiErrorResponse(body, 429);
    expect(result?.body?.error?.message).toContain("Quota exhausted");
    expect(result?.retryAfterMs).toBeUndefined();
  });

  it("adds validation links for VALIDATION_REQUIRED errors", () => {
    const body = {
      error: {
        message: "validation required",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "VALIDATION_REQUIRED",
            domain: "cloudcode-pa.googleapis.com",
          },
          {
            "@type": "type.googleapis.com/google.rpc.Help",
            links: [
              { url: "https://example.com/validate" },
              { description: "Learn more", url: "https://support.google.com/help" },
            ],
          },
        ],
      },
    };

    const result = enhanceGeminiErrorResponse(body, 403);
    expect(result?.body?.error?.message).toContain("Complete validation: https://example.com/validate");
    expect(result?.body?.error?.message).toContain("Learn more: https://support.google.com/help");
  });

  it("extracts retry delay from message text when details are missing", () => {
    const body = {
      error: {
        message: "Please retry in 2s",
      },
    };

    const result = enhanceGeminiErrorResponse(body, 503);
    expect(result?.retryAfterMs).toBe(2000);
  });
});
