import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { fetchWithRetry, retryInternals } from "./retry";

const originalSetTimeout = globalThis.setTimeout;

function makeQuota429(reason: "RATE_LIMIT_EXCEEDED" | "QUOTA_EXHAUSTED", retryDelay?: string): Response {
  const details: Record<string, unknown>[] = [
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason,
      domain: "cloudcode-pa.googleapis.com",
    },
  ];
  if (retryDelay) {
    details.push({
      "@type": "type.googleapis.com/google.rpc.RetryInfo",
      retryDelay,
    });
  }
  return new Response(
    JSON.stringify({
      error: {
        message: "rate limited",
        details,
      },
    }),
    {
      status: 429,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("fetchWithRetry", () => {
  beforeEach(() => {
    mock.restore();
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: (...args: any[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
  });

  afterEach(() => {
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout;
  });

  it("retries transient network errors", async () => {
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        const err = new Error("socket reset") as Error & { code?: string };
        err.code = "ECONNRESET";
        throw err;
      }
      return new Response("ok", { status: 200 });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("retries rate-limit responses with retry hints", async () => {
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return makeQuota429("RATE_LIMIT_EXCEEDED", "1500ms");
      }
      return new Response("ok", { status: 200 });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("does not retry terminal quota exhaustion", async () => {
    const fetchMock = mock(async () => makeQuota429("QUOTA_EXHAUSTED"));
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(429);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("retries immediately when server returns Retry-After: 0", async () => {
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response("ok", { status: 200 });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(2);
  });
});

describe("retryInternals", () => {
  it("parses retry delays from both ms and s notation", () => {
    expect(retryInternals.parseRetryDelayValue("1200ms")).toBe(1200);
    expect(retryInternals.parseRetryDelayValue("1.5s")).toBe(1500);
    expect(retryInternals.parseRetryDelayFromMessage("Please retry in 2s")).toBe(2000);
  });
});
