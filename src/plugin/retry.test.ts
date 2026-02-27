import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { fetchWithRetry, retryInternals } from "./retry";

const originalSetTimeout = globalThis.setTimeout;
const scheduledDelays: number[] = [];

function makeQuota429(
  reason: "RATE_LIMIT_EXCEEDED" | "QUOTA_EXHAUSTED" | "MODEL_CAPACITY_EXHAUSTED",
  retryDelay?: string,
  wrappedAsArray = false,
): Response {
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
  const payload = {
    error: {
      message: "rate limited",
      details,
    },
  };
  return new Response(
    JSON.stringify(
      wrappedAsArray
        ? [payload]
        : payload,
    ),
    {
      status: 429,
      headers: { "content-type": "application/json" },
    },
  );
}

function makeQuota429WithMessage(
  reason: "RATE_LIMIT_EXCEEDED" | "QUOTA_EXHAUSTED" | "MODEL_CAPACITY_EXHAUSTED",
  message: string,
  wrappedAsArray = false,
): Response {
  const details: Record<string, unknown>[] = [
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason,
      domain: "cloudcode-pa.googleapis.com",
    },
  ];
  const payload = {
    error: {
      message,
      details,
    },
  };
  return new Response(
    JSON.stringify(
      wrappedAsArray
        ? [payload]
        : payload,
    ),
    {
      status: 429,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("fetchWithRetry", () => {
  beforeEach(() => {
    mock.restore();
    scheduledDelays.length = 0;
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
      fn: (...args: any[]) => void,
      delay?: number | undefined,
    ) => {
      scheduledDelays.push(typeof delay === "number" ? delay : 0);
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

  it("fails fast on model capacity exhaustion when no retry hint is provided", async () => {
    const fetchMock = mock(async () => makeQuota429("MODEL_CAPACITY_EXHAUSTED"));
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(429);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("fails fast on array-wrapped model capacity exhaustion payload", async () => {
    const fetchMock = mock(async () =>
      makeQuota429WithMessage(
        "MODEL_CAPACITY_EXHAUSTED",
        "No capacity available for model gemini-3-flash-preview on the server",
        true,
      ),
    );
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(429);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("applies cooldown after terminal model capacity exhaustion", async () => {
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return makeQuota429WithMessage(
          "MODEL_CAPACITY_EXHAUSTED",
          "No capacity available for model gemini-3-flash-preview on the server",
          true,
        );
      }
      return new Response("ok", { status: 200 });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const firstResponse = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ project: "project-1", model: "gemini-3-flash-preview" }),
    });
    const secondResponse = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ project: "project-1", model: "gemini-3-flash-preview" }),
    });

    expect(firstResponse.status).toBe(429);
    expect(secondResponse.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(2);
    expect(scheduledDelays).toContain(8000);
  });

  it("retries model capacity exhaustion when server provides RetryInfo", async () => {
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return makeQuota429("MODEL_CAPACITY_EXHAUSTED", "500ms");
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

  it("applies cooldown across requests to avoid repeated initial 429s", async () => {
    const fetchMock = mock(async () => {
      const callNumber = fetchMock.mock.calls.length;
      if (callNumber === 1) {
        return makeQuota429("RATE_LIMIT_EXCEEDED", "1500ms");
      }
      if (callNumber === 3 && scheduledDelays.length < 2) {
        return makeQuota429("RATE_LIMIT_EXCEEDED", "1500ms");
      }
      return new Response("ok", { status: 200 });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const firstResponse = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ project: "project-1", model: "gemini-2.5-flash" }),
    });
    const secondResponse = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ project: "project-1", model: "gemini-2.5-flash" }),
    });

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(3);
    expect(scheduledDelays.length).toBe(2);
    expect(scheduledDelays[0]).toBe(1500);
    expect(scheduledDelays[1]).toBe(1500);
  });
});

describe("retryInternals", () => {
  it("parses retry delays from both ms and s notation", () => {
    expect(retryInternals.parseRetryDelayValue("1200ms")).toBe(1200);
    expect(retryInternals.parseRetryDelayValue("1.5s")).toBe(1500);
    expect(retryInternals.parseRetryDelayFromMessage("Please retry in 2s")).toBe(2000);
  });
});
