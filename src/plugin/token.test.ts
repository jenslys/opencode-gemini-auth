import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { GEMINI_PROVIDER_ID } from "../constants";
import { refreshAccessToken } from "./token";
import type { OAuthAuthDetails, PluginClient } from "./types";

const originalSetTimeout = globalThis.setTimeout;

const baseAuth: OAuthAuthDetails = {
  type: "oauth",
  refresh: "refresh-token|project-123",
  access: "old-access",
  expires: Date.now() - 1000,
};

function createClient() {
  return {
    auth: {
      set: mock(async () => {}),
    },
  } as PluginClient & {
    auth: { set: ReturnType<typeof mock<(input: any) => Promise<void>>> };
  };
}

describe("refreshAccessToken", () => {
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

  it("updates the caller but skips persisting when refresh token is unchanged", async () => {
    const client = createClient();
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth, client);

    expect(result?.access).toBe("new-access");
    expect(client.auth.set.mock.calls.length).toBe(0);
  });

  it("persists when Google rotates the refresh token", async () => {
    const client = createClient();
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          access_token: "next-access",
          expires_in: 3600,
          refresh_token: "rotated-token",
        }),
        { status: 200 },
      );
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth, client);

    expect(result?.access).toBe("next-access");
    expect(client.auth.set.mock.calls.length).toBe(1);
    expect(client.auth.set.mock.calls[0]?.[0]).toEqual({
      path: { id: GEMINI_PROVIDER_ID },
      body: expect.objectContaining({
        type: "oauth",
        refresh: expect.stringContaining("rotated-token"),
      }),
    });
  });

  it("deduplicates concurrent refresh calls for the same refresh token", async () => {
    const client = createClient();
    let releaseFetch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });

    const fetchMock = mock(async () => {
      await gate;
      return new Response(
        JSON.stringify({
          access_token: "deduped-access",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const first = refreshAccessToken(baseAuth, client);
    const second = refreshAccessToken(baseAuth, client);
    await Promise.resolve();

    expect(fetchMock.mock.calls.length).toBe(1);
    releaseFetch();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult?.access).toBe("deduped-access");
    expect(secondResult?.access).toBe("deduped-access");
  });

  it("retries transient network errors during token refresh", async () => {
    const client = createClient();
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        const err = new Error("socket reset") as Error & { code?: string };
        err.code = "ECONNRESET";
        throw err;
      }
      return new Response(
        JSON.stringify({
          access_token: "recovered-access",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth, client);

    expect(result?.access).toBe("recovered-access");
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("retries retryable HTTP errors from token endpoint", async () => {
    const client = createClient();
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          access_token: "recovered-after-503",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth, client);

    expect(result?.access).toBe("recovered-after-503");
    expect(fetchMock.mock.calls.length).toBe(2);
  });
});
