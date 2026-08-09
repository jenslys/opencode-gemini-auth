import { afterEach, describe, expect, it, mock } from "bun:test";

mock.module("./config-store", () => ({
  loadAccountsFromDisk: async () => [],
  saveAccountsToDisk: async () => {}
}));

import { GeminiCLIOAuthPlugin, getLatestGeminiPool, resetPluginState } from "../plugin";
import type { PluginClient, Provider } from "./types";

function makeMockClient(): PluginClient {
  return {
    auth: { set: async () => {} },
    config: {
      get: async () => ({ data: undefined }),
    },
    tui: {
      showToast: async () => ({}),
    },
  };
}

function makeOAuthAuth() {
  return {
    type: "oauth" as const,
    refresh: "test-refresh-token|test-project",
    access: "test-access-token",
    expires: Date.now() + 3600000,
  };
}

describe("multi-account plugin loader", () => {
  afterEach(() => {
    resetPluginState();
  });

  it("creates pool-of-one when no accounts configured", async () => {
    const plugin = await GeminiCLIOAuthPlugin({ client: makeMockClient() });
    const getAuth = mock(async () => makeOAuthAuth());
    const provider: Provider = { models: {} };

    const result = await plugin.auth.loader(getAuth, provider);
    expect(result).not.toBeNull();

    const pool = getLatestGeminiPool();
    expect(pool).toBeDefined();
    expect(pool!.count()).toBe(1);
  });

  it("creates pool with accounts from provider options", async () => {
    const plugin = await GeminiCLIOAuthPlugin({ client: makeMockClient() });
    const getAuth = mock(async () => makeOAuthAuth());
    const provider: Provider = {
      models: {},
      options: {
        accounts: [
          { id: "user1", refreshToken: "rt1", enabled: true },
          { id: "user2", refreshToken: "rt2", enabled: true },
          { id: "user3", refreshToken: "rt3", enabled: true },
        ],
      },
    };

    const result = await plugin.auth.loader(getAuth, provider);
    expect(result).not.toBeNull();

    const pool = getLatestGeminiPool();
    expect(pool).toBeDefined();
    expect(pool!.count()).toBe(3);
  });

  it("returns loader result with fetch function", async () => {
    const plugin = await GeminiCLIOAuthPlugin({ client: makeMockClient() });
    const getAuth = mock(async () => makeOAuthAuth());
    const provider: Provider = { models: {} };

    const result = await plugin.auth.loader(getAuth, provider);
    expect(result).not.toBeNull();
    expect(typeof result!.fetch).toBe("function");
  });

  it("returns null for non-OAuth auth", async () => {
    const plugin = await GeminiCLIOAuthPlugin({ client: makeMockClient() });
    const getAuth = mock(async () => ({ type: "api" }));
    const provider: Provider = { models: {} };

    const result = await plugin.auth.loader(getAuth, provider);
    expect(result).toBeNull();
  });

  it("updates auth for matching account from single getAuth() result", async () => {
    const plugin = await GeminiCLIOAuthPlugin({ client: makeMockClient() });
    const auth = makeOAuthAuth();
    const getAuth = mock(async () => auth);
    const provider: Provider = {
      models: {},
      options: {
        accounts: [
          { id: "user1", refreshToken: auth.refresh, enabled: true },
          { id: "user2", refreshToken: "rt2", enabled: true },
        ],
      },
    };

    await plugin.auth.loader(getAuth, provider);
    const pool = getLatestGeminiPool();
    expect(pool).toBeDefined();

    const acct1 = pool!.getAccount("user1");
    const acct2 = pool!.getAccount("user2");
    expect(acct1?.auth.access).toBe("test-access-token");
    expect(acct2?.auth.access).toBeUndefined();
  });

  it("backwards compatible: single-account without accounts[] config works", async () => {
    const plugin = await GeminiCLIOAuthPlugin({ client: makeMockClient() });
    const auth = makeOAuthAuth();
    const getAuth = mock(async () => auth);
    const provider: Provider = { models: {} };

    const result = await plugin.auth.loader(getAuth, provider);
    expect(result).not.toBeNull();

    const pool = getLatestGeminiPool();
    expect(pool).toBeDefined();
    expect(pool!.count()).toBe(1);
  });
});
