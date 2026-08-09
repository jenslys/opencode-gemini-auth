import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { buildRetryThrottleKey, fetchWithRetry, formatAllAccountsExhaustedMessage, retryInternals } from "./retry";
import { classifyQuotaResponse } from "./retry/quota";
import type { AccountState, CooldownState } from "./types";

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

  it("classifies cloudaicompanion quota errors", async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          message: "quota exhausted",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "QUOTA_EXHAUSTED",
              domain: "cloudaicompanion.googleapis.com",
            },
          ],
        },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    );

    await expect(classifyQuotaResponse(response)).resolves.toEqual({
      terminal: true,
      reason: "QUOTA_EXHAUSTED",
    });
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
    expect(scheduledDelays[1]).toBeGreaterThan(0);
    expect(scheduledDelays[1]).toBeLessThanOrEqual(1500);
  });

  it("accepts accountId parameter without breaking existing behavior", async () => {
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        const err = new Error("socket reset") as Error & { code?: string };
        err.code = "ECONNRESET";
        throw err;
      }
      return new Response("ok", { status: 200 });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry(
      "https://example.com",
      { method: "POST", body: JSON.stringify({ hello: "world" }) },
      "test-account",
    );

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("includes terminal 429 headers when accountId is provided", async () => {
    const fetchMock = mock(async () => makeQuota429("QUOTA_EXHAUSTED"));
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry(
      "https://example.com",
      { method: "POST", body: JSON.stringify({ hello: "world" }) },
      "acct-1",
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("X-Gemini-Terminal-429")).toBe("true");
    expect(response.headers.get("X-Gemini-429-Reason")).toBe("QUOTA_EXHAUSTED");
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("includes terminal 429 headers for model capacity exhaustion", async () => {
    const fetchMock = mock(async () => makeQuota429WithMessage(
      "MODEL_CAPACITY_EXHAUSTED",
      "No capacity available for model gemini-3-flash-preview on the server",
      true,
    ));
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry(
      "https://example.com",
      { method: "POST", body: JSON.stringify({ hello: "world" }) },
      "acct-1",
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("X-Gemini-Terminal-429")).toBe("true");
    expect(response.headers.get("X-Gemini-429-Reason")).toBe("MODEL_CAPACITY_EXHAUSTED");
  });

  it("passes accountId through to retry throttle key", () => {
    const keyWith = buildRetryThrottleKey(
      "https://example.com",
      { body: JSON.stringify({ project: "p1", model: "m1" }) },
      "acct-1",
    );
    const keyWithout = buildRetryThrottleKey(
      "https://example.com",
      { body: JSON.stringify({ project: "p1", model: "m1" }) },
    );

    expect(keyWith).toContain("account:acct-1");
    expect(keyWithout).not.toContain("account:");
    expect(keyWith).not.toBe(keyWithout);
  });
});

describe("formatAllAccountsExhaustedMessage", () => {
  it("formats single account with no cooldown", () => {
    const now = Date.now();
    const accounts: AccountState[] = [{
      account: { id: "user1", refreshToken: "rt1", enabled: true },
      auth: { type: "oauth", refresh: "rt1" },
      cooldowns: new Map(),
      lastUsed: now,
      usageCount: 0,
      health: { value: 1.0, successRate: 1.0, quotaRemaining: 1.0, latencyScore: 1.0, cooldownScore: 1.0 },
    }];

    const result = formatAllAccountsExhaustedMessage(accounts);
    expect(result).toContain("All accounts exhausted.");
    expect(result).toContain("user1");
    expect(result).toContain("no cooldown");
  });

  it("lists active cooldowns with remaining time", () => {
    const now = Date.now();
    const cooldown: CooldownState = {
      accountId: "user1",
      expiresAt: now + 30000,
      reason: "QUOTA_EXHAUSTED",
      model: "gemini-2.5-flash",
    };
    const accounts: AccountState[] = [{
      account: { id: "user1", refreshToken: "rt1", enabled: true },
      auth: { type: "oauth", refresh: "rt1" },
      cooldowns: new Map([["gemini-2.5-flash", cooldown]]),
      lastUsed: now,
      usageCount: 0,
      health: { value: 1.0, successRate: 1.0, quotaRemaining: 1.0, latencyScore: 1.0, cooldownScore: 1.0 },
    }];

    const result = formatAllAccountsExhaustedMessage(accounts);
    expect(result).toContain("user1");
    expect(result).toContain("gemini-2.5-flash: QUOTA_EXHAUSTED");
    expect(result).toContain("30s");
  });

  it("handles multiple accounts with mix of cooldowns and non-cooldowned", () => {
    const now = Date.now();
    const accounts: AccountState[] = [
      {
        account: { id: "user1", refreshToken: "rt1", enabled: true },
        auth: { type: "oauth", refresh: "rt1" },
        cooldowns: new Map(),
        lastUsed: now,
        usageCount: 0,
        health: { value: 1.0, successRate: 1.0, quotaRemaining: 1.0, latencyScore: 1.0, cooldownScore: 1.0 },
      },
      {
        account: { id: "user2", refreshToken: "rt2", enabled: true, email: "user2@test.com" },
        auth: { type: "oauth", refresh: "rt2" },
        cooldowns: new Map([
          ["model-x", {
            accountId: "user2",
            expiresAt: now + 10000,
            reason: "MODEL_CAPACITY_EXHAUSTED",
            model: "model-x",
          } as CooldownState],
        ]),
        lastUsed: now,
        usageCount: 0,
        health: { value: 0.5, successRate: 0.5, quotaRemaining: 0.5, latencyScore: 1.0, cooldownScore: 0.5 },
      },
    ];

    const result = formatAllAccountsExhaustedMessage(accounts);
    expect(result).toContain("user1: no cooldown");
    expect(result).toContain("user2");
    expect(result).toContain("model-x: MODEL_CAPACITY_EXHAUSTED");
    expect(result).toContain("10s");
    expect(result).toContain("All accounts exhausted.");
  });

  it("excludes expired cooldowns from output", () => {
    const now = Date.now();
    const expiredCooldown: CooldownState = {
      accountId: "user1",
      expiresAt: now - 1000,
      reason: "QUOTA_EXHAUSTED",
      model: "gemini-2.5-flash",
    };
    const accounts: AccountState[] = [{
      account: { id: "user1", refreshToken: "rt1", enabled: true },
      auth: { type: "oauth", refresh: "rt1" },
      cooldowns: new Map([["gemini-2.5-flash", expiredCooldown]]),
      lastUsed: now,
      usageCount: 0,
      health: { value: 1.0, successRate: 1.0, quotaRemaining: 1.0, latencyScore: 1.0, cooldownScore: 1.0 },
    }];

    const result = formatAllAccountsExhaustedMessage(accounts);
    expect(result).toContain("no cooldown");
    expect(result).not.toContain("QUOTA_EXHAUSTED");
  });
});

describe("retryInternals", () => {
  it("parses retry delays from both ms and s notation", () => {
    expect(retryInternals.parseRetryDelayValue("1200ms")).toBe(1200);
    expect(retryInternals.parseRetryDelayValue("1.5s")).toBe(1500);
    expect(retryInternals.parseRetryDelayFromMessage("Please retry in 2s")).toBe(2000);
  });
});
