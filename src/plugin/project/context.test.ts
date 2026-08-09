import { beforeEach, describe, expect, it, mock } from "bun:test";

import {
  ensureProjectContextForAccount,
  invalidateProjectContextCacheForAccount,
} from "../project";
import type { OAuthAuthDetails, PluginClient } from "../types";
import { buildProjectCacheKeyForAccount } from "./utils";

const baseAuth: OAuthAuthDetails = {
  type: "oauth",
  refresh: "refresh-token",
  access: "access-token",
  expires: Date.now() + 60_000,
};

function createClient(): PluginClient {
  return {
    auth: {
      set: mock(async () => {}),
    },
  } as PluginClient;
}

describe("buildProjectCacheKeyForAccount", () => {
  it("returns a stable key for an account and project", () => {
    const key = buildProjectCacheKeyForAccount("alice@test.com", "my-project");
    expect(key).toBe("account:alice@test.com|project:my-project");
  });

  it("returns a stable key with default project when projectId is omitted", () => {
    const key = buildProjectCacheKeyForAccount("bob@test.com");
    expect(key).toBe("account:bob@test.com|project:default");
  });
});

describe("ensureProjectContextForAccount", () => {
  beforeEach(() => {
    mock.restore();
  });

  it("caches by account ID and returns the same result on repeated calls", async () => {
    let fetchCount = 0;
    const fetchMock = mock(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(":loadCodeAssist")) {
        fetchCount++;
        return new Response(
          JSON.stringify({
            currentTier: { id: "free-tier" },
            cloudaicompanionProject: "projects/server-project",
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = createClient();

    const first = await ensureProjectContextForAccount(
      baseAuth,
      client,
      "alice@test.com",
      undefined,
      "gemini-3-flash-preview",
    );

    const second = await ensureProjectContextForAccount(
      baseAuth,
      client,
      "alice@test.com",
      undefined,
      "gemini-3-flash-preview",
    );

    // Second call should hit cache, so fetchCount === 1
    expect(fetchCount).toBe(1);
    expect(first.effectiveProjectId).toBe("projects/server-project");
    expect(second.effectiveProjectId).toBe(first.effectiveProjectId);
  });

  it("maintains separate cache entries for different accounts with the same project", async () => {
    let fetchCount = 0;
    const fetchMock = mock(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(":loadCodeAssist")) {
        fetchCount++;
        return new Response(
          JSON.stringify({
            currentTier: { id: "free-tier" },
            cloudaicompanionProject: "projects/server-project",
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = createClient();

    const aliceResult = await ensureProjectContextForAccount(
      baseAuth,
      client,
      "alice@test.com",
      "shared-project",
      "gemini-3-flash-preview",
    );

    const bobResult = await ensureProjectContextForAccount(
      baseAuth,
      client,
      "bob@test.com",
      "shared-project",
      "gemini-3-flash-preview",
    );

    // Each account should have triggered a separate fetch (different cache keys)
    expect(fetchCount).toBe(2);
    expect(aliceResult.effectiveProjectId).toBeTruthy();
    expect(bobResult.effectiveProjectId).toBeTruthy();
  });
});

describe("invalidateProjectContextCacheForAccount", () => {
  beforeEach(() => {
    mock.restore();
  });

  it("removes the correct cache entry, forcing a new fetch", async () => {
    let fetchCount = 0;
    const fetchMock = mock(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(":loadCodeAssist")) {
        fetchCount++;
        return new Response(
          JSON.stringify({
            currentTier: { id: "free-tier" },
            cloudaicompanionProject: "projects/server-project",
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = createClient();

    // First call populates the cache
    await ensureProjectContextForAccount(
      baseAuth,
      client,
      "alice@test.com",
      "my-project",
      "gemini-3-flash-preview",
    );

    // Invalidate
    invalidateProjectContextCacheForAccount("alice@test.com", "my-project");

    // Second call should fetch again
    await ensureProjectContextForAccount(
      baseAuth,
      client,
      "alice@test.com",
      "my-project",
      "gemini-3-flash-preview",
    );

    // Two fetches because invalidation removed the cache entry
    expect(fetchCount).toBe(2);
  });
});
