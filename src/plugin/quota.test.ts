import { beforeEach, describe, expect, it, mock } from "bun:test";

import { retrieveUserQuota, formatQuotaResponse } from "./quota";
import type { QuotaResponse } from "./quota";

describe("retrieveUserQuota", () => {
  beforeEach(() => {
    mock.restore();
  });

  it("successfully retrieves quota data", async () => {
    const mockResponse: QuotaResponse = {
      buckets: [
        {
          resetTime: "2026-01-14T22:57:56Z",
          tokenType: "REQUESTS",
          modelId: "gemini-2.0-flash",
          remainingFraction: 1,
        },
        {
          resetTime: "2026-01-14T00:51:35Z",
          tokenType: "REQUESTS",
          modelId: "gemini-2.5-pro",
          remainingFraction: 0.804,
        },
      ],
    };

    const fetchMock = mock(async () => {
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await retrieveUserQuota("test-access-token");

    expect(result.buckets).toHaveLength(2);
    expect(result.buckets[0]?.modelId).toBe("gemini-2.0-flash");
    expect(result.buckets[1]?.remainingFraction).toBe(0.804);
  });

  it("throws error on failed request", async () => {
    const fetchMock = mock(async () => {
      return new Response("Unauthorized", { status: 401, statusText: "Unauthorized" });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    await expect(retrieveUserQuota("invalid-token")).rejects.toThrow(
      "Failed to retrieve quota: 401 Unauthorized",
    );
  });
});

describe("formatQuotaResponse", () => {
  it("formats quota response with multiple models", () => {
    const quota: QuotaResponse = {
      buckets: [
        {
          resetTime: "2026-01-14T22:57:56Z",
          tokenType: "REQUESTS",
          modelId: "gemini-2.0-flash",
          remainingFraction: 1,
        },
        {
          resetTime: "2026-01-14T00:51:35Z",
          tokenType: "REQUESTS",
          modelId: "gemini-2.5-pro",
          remainingFraction: 0.804,
        },
      ],
    };

    const formatted = formatQuotaResponse(quota);

    expect(formatted).toContain("Gemini API Quota:");
    expect(formatted).toContain("gemini-2.0-flash: 100.0% remaining");
    expect(formatted).toContain("gemini-2.5-pro: 80.4% remaining");
  });

  it("handles empty buckets", () => {
    const quota: QuotaResponse = {
      buckets: [],
    };

    const formatted = formatQuotaResponse(quota);

    expect(formatted).toBe("No quota information available.");
  });
});
